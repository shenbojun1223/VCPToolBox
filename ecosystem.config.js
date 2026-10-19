// PM2 Ecosystem Configuration
// 同时启动主服务 (server.js) 和管理面板 (adminServer.js)
//
// ⚠️ 内存说明（大知识库用户务必阅读）：
// 首次迁移或事实变化时，统一 AGS 几何任务使用临时单位向量快照，完成后释放。
// 局部残差与全局 EPA 在单事务发布；事实和配置不变时命中缓存，不推进派生版本。
// 这里不设置 PM2 的 max_memory_restart，避免首轮几何计算的短时 RSS 峰值
// 触发反复重启。旧 pair 缓存及 PCA/SVD 预计算已经退休。
// 如需在生产环境重新启用内存保护，可手动添加 max_memory_restart，例如 "4096M"。

// 显式指定解释器，避免 pm2 用字面量 'node' 交给 PATH 解析，
// 从而在多 Node 版本环境下解析到与原生模块 ABI 不匹配的 node。
// 允许用 VCP_NODE_INTERPRETER 覆盖（例如便携运行时场景）。
const NODE_INTERPRETER = process.env.VCP_NODE_INTERPRETER || process.execPath;

module.exports = {
  apps: [
    {
      name: 'vcp-main',
      script: 'server.js',
      interpreter: NODE_INTERPRETER,
      watch: false,
      // 不设置 max_memory_restart：允许主服务按系统可用内存自然增长。
      // 本次诊断启动配置已准备；仅在用户手动按本文件重启后生效。
      // 不再使用固定同名 --cpu-prof，避免与分段主线程采样并行或覆盖。
      node_args: [],
      kill_timeout: 15000,
      env: {
        NODE_ENV: 'production',
        UV_THREADPOOL_SIZE: '16',
        MaxVCPLoopStream: '20',
        MaxVCPLoopNonStream: '20',
        VCP_DIAGNOSTICS_ENABLED: 'true',
        VCP_DIAGNOSTICS_CPU_ENABLED: 'true',
        VCP_DIAGNOSTICS_WATCHDOG_ENABLED: 'false',
        VCP_DIAGNOSTICS_DIR: 'C:/VCP/VCPToolBox/DebugLog/diagnostics',
        VCP_DIAGNOSTICS_CPU_SAMPLING_MS: '10',
        VCP_DIAGNOSTICS_CPU_SEGMENT_MS: '60000',
        VCP_DIAGNOSTICS_CPU_MAX_SEGMENTS: '8',
        VCP_DIAGNOSTICS_CPU_MAX_TOTAL_BYTES: '268435456',
        VCP_DIAGNOSTICS_QUEUE_LIMIT: '2048',
        VCP_DIAGNOSTICS_MAX_LINE_BYTES: '4096',
        VCP_DIAGNOSTICS_MAX_FILE_BYTES: '8388608',
        VCP_DIAGNOSTICS_MAX_FILES: '8',
        VCP_DIAGNOSTICS_MAX_TOTAL_BYTES: '67108864'
      }
    },
    {
      name: 'vcp-admin',
      script: 'adminServer.js',
      interpreter: NODE_INTERPRETER,
      watch: false,
      node_args: [],
      // 不设置 max_memory_restart：避免管理面板被 PM2 因短时 RSS 波动重启。
      kill_timeout: 5000,
      // 等待主服务初始化后再启动管理面板
      wait_ready: false,
      restart_delay: 5000,
      env: {
        NODE_ENV: 'production',
        VCP_DIAGNOSTICS_ENABLED: 'true',
        VCP_DIAGNOSTICS_CPU_ENABLED: 'true',
        VCP_DIAGNOSTICS_WATCHDOG_ENABLED: 'false',
        VCP_DIAGNOSTICS_DIR: 'C:/VCP/VCPToolBox/DebugLog/diagnostics',
        VCP_DIAGNOSTICS_CPU_SAMPLING_MS: '10',
        VCP_DIAGNOSTICS_CPU_SEGMENT_MS: '60000',
        VCP_DIAGNOSTICS_CPU_MAX_SEGMENTS: '8',
        VCP_DIAGNOSTICS_CPU_MAX_TOTAL_BYTES: '268435456',
        VCP_DIAGNOSTICS_QUEUE_LIMIT: '2048',
        VCP_DIAGNOSTICS_MAX_LINE_BYTES: '4096',
        VCP_DIAGNOSTICS_MAX_FILE_BYTES: '8388608',
        VCP_DIAGNOSTICS_MAX_FILES: '8',
        VCP_DIAGNOSTICS_MAX_TOTAL_BYTES: '67108864'
      }
    }
  ]
};
