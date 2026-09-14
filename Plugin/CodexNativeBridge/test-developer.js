"use strict";

const http = require("http");

const data = JSON.stringify({
    model: "gpt-5.6-sol-xhigh-appsvr",
    messages: [
        {
            role: "system",
            content: "你是一个 VCP Agent。当需要执行工具时，你的第一个输出字符必须是 <<<[TOOL_REQUEST]>>>，严禁任何前置寒暄或口头预告。格式必须严格为：\n<<<[TOOL_REQUEST]>>>\nmaid:「始」测试