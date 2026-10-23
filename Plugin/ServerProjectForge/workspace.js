'use strict';
// 工作区解析：写入白名单来自“已启用工作区根目录 + 插件配置 ALLOWED_DIRECTORIES”，
// 每次调用实时计算，设置页增删/停用工作区后立即生效。
// 工程根目录按 workspace_id + subpath 定位，工作区整体搬家后仍可找到。

const fs = require('fs');
const path = require('path');
const { isPathInside, toPosixRelative } = fs.existsSync(path.join(__dirname, 'fileKit', 'paths.js'))
    ? require('./fileKit/paths')
    : require('../../shared/fileKit/paths');

function normalizeAlias(value) {
    return String(value || '').trim().toLowerCase();
}

/**
 * 解析静态工作区配置（供服务器端 VCPToolBox 或未注入 workspaceService 的宿主使用）。
 * 支持格式：
 * - JSON 数组：[{"id":"vcptoolbox","alias":"vcptoolbox","path":"C:\\VCP\\VCPToolBox","enabled":true}]
 * - 分号/换行分隔的 alias|path（或 alias=path）：vcptoolbox|C:\VCP\VCPToolBox;vcpchat|C:\VCP\VCPChat
 */
function parseStaticWorkspaces(spec) {
    if (!spec) return [];
    if (Array.isArray(spec)) {
        return spec
            .filter(item => item && item.path)
            .map(item => {
                const alias = String(item.alias || item.id || path.basename(item.path)).trim();
                return {
                    id: String(item.id || normalizeAlias(alias)),
                    alias,
                    path: path.resolve(String(item.path).trim()),
                    enabled: item.enabled !== false,
                };
            });
    }
    const raw = String(spec).trim();
    if (!raw) return [];
    if (raw.startsWith('[')) {
        try { return parseStaticWorkspaces(JSON.parse(raw)); } catch (_e) { /* 回退文本解析 */ }
    }
    const entries = [];
    for (const token of raw.split(/[;\r\n]+/)) {
        const line = token.trim();
        if (!line) continue;
        const sepIdx = line.indexOf('|') !== -1 ? line.indexOf('|') : line.indexOf('=');
        let alias;
        let dir;
        if (sepIdx > 0) {
            alias = line.slice(0, sepIdx).trim();
            dir = line.slice(sepIdx + 1).trim();
        } else {
            dir = line;
            alias = path.basename(path.resolve(dir));
        }
        if (!dir) continue;
        const abs = path.resolve(dir);
        entries.push({
            id: normalizeAlias(alias) || normalizeAlias(path.basename(abs)),
            alias: alias || path.basename(abs),
            path: abs,
            enabled: true,
        });
    }
    return entries;
}

class WorkspaceResolver {
    /**
     * @param {object} options
     * @param {object|null} options.workspaceService 主进程注入的只读门面（可为空，例如单测或服务器端独立运行）
     * @param {string[]} [options.extraAllowed] 额外允许的目录（插件 config.env 的 ALLOWED_DIRECTORIES）
     * @param {string|Array} [options.staticWorkspaces] 静态工作区声明（插件 config.env 的 WORKSPACES）
     * @param {string|null} [options.activeWorkspace] 默认激活工作区别名/ID（插件 config.env 的 ACTIVE_WORKSPACE）
     */
    constructor({ workspaceService = null, extraAllowed = [], staticWorkspaces = [], activeWorkspace = null } = {}) {
        this.workspaceService = workspaceService;
        this.extraAllowed = extraAllowed.map(dir => String(dir).trim()).filter(Boolean).map(dir => path.resolve(dir));
        this.staticWorkspaces = parseStaticWorkspaces(staticWorkspaces);
        this.activeWorkspace = activeWorkspace ? String(activeWorkspace).trim() : null;
    }

    list() {
        let dynamic = [];
        try {
            dynamic = this.workspaceService?.list?.() || [];
        } catch (_e) {
            dynamic = [];
        }
        if (!this.staticWorkspaces.length) return dynamic;
        if (!dynamic.length) return [...this.staticWorkspaces];
        const seen = new Set(dynamic.map(ws => normalizeAlias(ws.alias || ws.id)));
        const merged = [...dynamic];
        for (const ws of this.staticWorkspaces) {
            if (!seen.has(normalizeAlias(ws.alias || ws.id))) {
                merged.push(ws);
            }
        }
        return merged;
    }

    enabled() {
        return this.list().filter(ws => ws.enabled);
    }

    /** 写入白名单根目录 */
    allowedRoots() {
        return [...this.enabled().map(ws => path.resolve(ws.path)), ...this.extraAllowed];
    }

    isWritable(absPath) {
        return this.allowedRoots().some(root => isPathInside(absPath, root));
    }

    /** 按 id 或别名查找（大小写不敏感）；includeDisabled 用于读取已停用工作区的工程。 */
    find(ref, { includeDisabled = false } = {}) {
        if (!ref) return null;
        const key = normalizeAlias(ref);
        const pool = includeDisabled ? this.list() : this.enabled();
        return pool.find(ws => ws.id === ref || normalizeAlias(ws.alias) === key) || null;
    }

    active() {
        let id = null;
        try { id = this.workspaceService?.getActiveWorkspaceId?.() || null; } catch (_e) { id = null; }
        if (id) {
            const found = this.find(id);
            if (found) return found;
        }
        if (this.activeWorkspace) {
            const found = this.find(this.activeWorkspace);
            if (found) return found;
        }
        return null;
    }

    describeAvailable() {
        const list = this.enabled();
        const lines = list.map(ws => `- \`${ws.alias}\` → ${ws.path}`);
        return lines.length ? lines.join('\n') : '- （无）请先在“全局设置 → 工作区管理”中登记工作区。';
    }

    /**
     * 为新工程确定根目录。
     * workspaceRef：别名/id；为空时依次取当前工作区、唯一启用的工作区。
     * subdir：工作区内子目录（相对路径），或位于白名单内的绝对路径。
     */
    resolveNewProjectRoot(workspaceRef, subdir) {
        const sub = typeof subdir === 'string' ? subdir.trim() : '';

        // 绝对路径：直接按白名单判定，归属到所在工作区（若有）
        if (sub && path.isAbsolute(sub)) {
            const abs = path.resolve(sub);
            if (!this.isWritable(abs)) {
                throw new Error(`目录不在任何已启用工作区或允许目录内：${abs}\n可用工作区：\n${this.describeAvailable()}`);
            }
            const ws = this.enabled()
                .filter(item => isPathInside(abs, item.path))
                .sort((a, b) => b.path.length - a.path.length)[0] || null;
            return {
                root: abs,
                workspace: ws,
                subpath: ws ? toPosixRelative(ws.path, abs) : '',
            };
        }

        let ws = null;
        if (workspaceRef) {
            ws = this.find(workspaceRef);
            if (!ws) throw new Error(`工作区“${workspaceRef}”不存在或已停用。可用工作区：\n${this.describeAvailable()}`);
        } else {
            ws = this.active();
            if (!ws && this.enabled().length === 1) ws = this.enabled()[0];
            if (!ws) {
                throw new Error(`未指定工作区，且当前没有选定工作区。请提供 workspace（别名）。可用工作区：\n${this.describeAvailable()}`);
            }
        }
        const root = path.resolve(ws.path, ...sub.split(/[/\\]+/).filter(Boolean));
        if (!isPathInside(root, ws.path)) throw new Error(`子目录越出工作区：${sub}`);
        return { root, workspace: ws, subpath: toPosixRelative(ws.path, root) };
    }

    /**
     * 解析工程当前的根目录与可写状态。
     * @returns {{ root: string, writable: boolean, blockedReason: string|null, workspaceAlias: string|null }}
     */
    projectRoot(project) {
        if (project.workspace_id) {
            const ws = this.find(project.workspace_id, { includeDisabled: true });
            if (ws) {
                const root = path.resolve(ws.path, ...String(project.subpath || '').split('/').filter(Boolean));
                if (!ws.enabled) {
                    return { root, writable: false, blockedReason: `工作区“${ws.alias}”已停用，工程只读。`, workspaceAlias: ws.alias };
                }
                return { root, writable: true, blockedReason: null, workspaceAlias: ws.alias };
            }
            // 工作区服务不可用或已被移除：回退到记录的根目录，但仍需通过白名单
        }
        const root = path.resolve(project.root);
        const writable = this.isWritable(root);
        return {
            root,
            writable,
            blockedReason: writable ? null : `工程所属工作区已被移除或不可用，工程只读（根目录：${root}）。`,
            workspaceAlias: project.workspace_alias || null,
        };
    }

    /**
     * 解析工程内路径。相对路径基于工程根；绝对路径必须位于工程根内。
     * @returns {{ abs: string, rel: string }} rel 为 posix 相对路径，用作数据库键
     */
    resolveInProject(projectRootInfo, inputPath) {
        const raw = String(inputPath || '').trim().replace(/^["']|["']$/g, '');
        if (!raw) throw new Error('缺少 path。');
        const abs = path.isAbsolute(raw)
            ? path.resolve(raw)
            : path.resolve(projectRootInfo.root, ...raw.split(/[/\\]+/).map(part => part.trim()).filter(Boolean));
        if (!isPathInside(abs, projectRootInfo.root) || abs === path.resolve(projectRootInfo.root)) {
            throw new Error(`路径越出工程根目录：${raw}（工程根：${projectRootInfo.root}）`);
        }
        return { abs, rel: toPosixRelative(projectRootInfo.root, abs) };
    }
}

module.exports = { WorkspaceResolver };