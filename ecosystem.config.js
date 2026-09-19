// PM2 Ecosystem Configuration
// 同时启动主服务 (server.js) 和管理面板 (adminServer.js)
//
// ⚠️ 内存说明（大知识库用户务必阅读）：
// 冷启动时 KnowledgeBaseManager 会把全部 tag 向量载入内存，
// 并执行 pairwise 相似度预计算 + EPA 加权 PCA/SVD，峰值内存与 tag 数量成正比。
// 这里不设置 PM2 的 max_memory_restart，避免大知识库冷启动峰值内存触发 PM2 RSS 超限重启，
// 导致 tag_pair_similarity 表仍为空并反复进入“全量阻塞重算 → 被杀 → 重启”的死循环。
// 如需在生产环境重新启用内存保护，可手动添加 max_memory_restart，例如 "4096M"。

module.exports = {
  apps: [
    {
      name: 'vcp-main',
      script: 'server.js',
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
