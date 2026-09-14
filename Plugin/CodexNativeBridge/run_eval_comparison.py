#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
双轨糖果评测对比脚本：
1. AICodeWorker / 原生 Codex CLI 模式 (codex exec)
2. VCP CodexNativeBridge (AppServer HTTP /v1/chat/completions)
"""

import sys
import os
import re
import json
import time
import subprocess
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed

CODEX_PROMPT = """不使用任何外部工具回答以下问题：

在一个黑色的袋子里放有三种口味的糖果，每种糖果有两种不同的形状（圆形和五角星形，不同的形状靠手感可以分辨）。现已知不同口味的糖和不同形状的数量统计如下表。参赛者需要在活动前决定摸出的糖果数目，那么，最少取出多少个糖果才能保证手中同时拥有不同形状的苹果味和桃子味的糖？（同时手中有圆形苹果味匹配五角星桃子味糖果，或者有圆形桃子味匹配五角星苹果味糖果都满足要求）

        苹果味  桃子味  西瓜味
圆形       7      9      8
五角星形   7      6      4
"""

ANSWER_PATTERN = re.compile(r"(?<!\d)21(?!\d)")
CODEX_BIN = r"C:\Users\Administrator\.vscode\extensions\openai.chatgpt-26.707.91948-win32-x64\bin\windows-x86_64\codex.exe"
BRIDGE_URL = "http://127.0.0.1:8318/v1/chat/completions"

def run_codex_cli(model: str, effort: str) -> dict:
    start = time.perf_counter()
    cmd = [
        CODEX_BIN, "exec", "--json",
        "--skip-git-repo-check",
        "--ephemeral",
        "-s", "read-only",
        "--disable", "memories",
        "-c", f"model_reasoning_effort={effort}",
        "-m", model
    ]
    proc = subprocess.run(
        cmd,
        input=CODEX_PROMPT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace"
    )
    elapsed = time.perf_counter() - start
    if proc.returncode != 0:
        return {"ok": False, "error": proc.stderr.strip() or proc.stdout.strip(), "elapsed": elapsed}

    final_text = ""
    usage = {}
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except Exception:
            continue
        if event.get("type") == "item.completed":
            item = event.get("item", {})
            if item.get("type") == "agent_message":
                final_text = item.get("text", final_text)
        elif event.get("type") == "turn.completed":
            usage = event.get("usage") or {}

    is_correct = bool(ANSWER_PATTERN.search(final_text))
    return {
        "ok": True,
        "correct": is_correct,
        "text": final_text,
        "elapsed": elapsed,
        "in_tok": usage.get("input_tokens"),
        "out_tok": usage.get("output_tokens"),
        "reason_tok": usage.get("reasoning_output_tokens")
    }

def run_vcp_bridge(model: str, effort: str) -> dict:
    start = time.perf_counter()
    # 根据 effort 构造模型名
    model_name = f"{model}-{effort}-appsvr" if effort != "default" else f"{model}-appsvr"
    payload = {
        "model": model_name,
        "messages": [
            {"role": "user", "content": CODEX_PROMPT}
        ],
        "stream": False
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        BRIDGE_URL,
        data=data,
        headers={"Content-Type": "application/json; charset=utf-8"}
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            body = resp.read().decode("utf-8")
            elapsed = time.perf_counter() - start
            res_json = json.loads(body)
            content = res_json["choices"][0]["message"]["content"]
            is_correct = bool(ANSWER_PATTERN.search(content))
            return {
                "ok": True,
                "correct": is_correct,
                "text": content,
                "elapsed": elapsed,
                "in_tok": "-",
                "out_tok": len(content),
                "reason_tok": "-"
            }
    except Exception as e:
        elapsed = time.perf_counter() - start
        return {"ok": False, "error": str(e), "elapsed": elapsed}

def test_tier(mode: str, model: str, effort: str, n: int = 5):
    print(f"\n[开始评测] 模式: {mode.upper()} | 模型: {model} | 推理档位: {effort} | 轮数: {n}")
    results = []
    for i in range(1, n + 1):
        if mode == "cli":
            res = run_codex_cli(model, effort)
        else:
            res = run_vcp_bridge(model, effort)
        results.append(res)
        status = "✓ 正确" if res.get("correct") else ("✗ 错误" if res.get("ok") else f"⚠️ 失败 ({res.get('error')[:30]})")
        print(f"  第 {i}/{n} 轮: {status} | 耗时: {res.get('elapsed', 0):.1f}s")
    
    correct_cnt = sum(1 for r in results if r.get("correct"))
    acc = (correct_cnt / n) * 100
    avg_time = sum(r.get("elapsed", 0) for r in results) / n
    print(f"  -> 结果: 准确率 {correct_cnt}/{n} ({acc:.1f}%) | 平均耗时 {avg_time:.1f}s")
    return {
        "mode": mode,
        "effort": effort,
        "total": n,
        "correct": correct_cnt,
        "accuracy": acc,
        "avg_time": avg_time,
        "details": results
    }

if __name__ == "__main__":
    target_mode = sys.argv[1] if len(sys.argv) > 1 else "both"
    efforts = ["low", "medium", "high", "xhigh"]
    model = "gpt-5.6-sol"
    n_runs = 5

    summary = []
    
    if target_mode in ("cli", "both"):
        print("\n==========================================")
        print("====== 轨道 1: 原生 Codex CLI (AICodeWorker) ======")
        print("==========================================")
        for eff in efforts:
            res = test_tier("cli", model, eff, n_runs)
            summary.append(res)

    if target_mode in ("bridge", "both"):
        print("\n==========================================")
        print("====== 轨道 2: VCP CodexNativeBridge (AppServer) ===")
        print("==========================================")
        for eff in efforts:
            res = test_tier("bridge", model, eff, n_runs)
            summary.append(res)

    print("\n\n==========================================")
    print("============= 最终评测对比汇总 =============")
    print("==========================================")
    print(f"{'模式':<12} | {'档位':<8} | {'通过率':<10} | {'准确率':<8} | {'平均耗时':<8}")
    print("-" * 55)
    for s in summary:
        print(f"{s['mode'].upper():<12} | {s['effort']:<8} | {s['correct']}/{s['total']:<8} | {s['accuracy']:>5.1f}% | {s['avg_time']:>6.1f}s")

    out_file = r"C:\VCP\VCPToolBox\Plugin\CodexNativeBridge\eval_result.json"
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    print(f"\n详细结果已写入: {out_file}")