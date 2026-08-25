# Agent Market 本地 Ollama Agent Tasks

- [x] T1：冻结 Requirements、Design、Contract、Tasks 和实施计划，建立共享 Agent Manifest/Lease/Result schema 与测试。
- [x] T2：实现 loopback-only Ollama client、DeepSeek/Kimi/Qwen/Zhipu provider API client、模型自动发现、owner-trained/third-party adapter、超时取消和安全 metadata。
- [x] T3：实现 HMAC 签名/验签、重放保护、控制面 HTTP client、幂等 runner、heartbeat/offline 和 mock 全链测试。
- [x] T4：新增 `/agents/local` 双语响应式页面，把 `personal-ai-agent-runtime:v4.1` 设为默认本地 Agent，并展示 DeepSeek/Kimi/Qwen/Zhipu provider API 节点；浏览器不直连 Ollama 或 provider key。
- [x] T4b：按 C 方案新增 Live Chat 协议、Worker `/agent/chat`/`/agent/healthz`、Local Stream Runtime 和工作流 playground。
- [x] T4c：移除 Mastra 运行依赖，以纯 LangGraph 承担状态边界；实现 Amend → Confirm → Start → Lock，并在页面提供节点标题编辑与节点 Agent 候选下拉选择。
- [ ] T5：生成架构图、时序图、manifest 与 mock/真实 smoke Evidence；运行一次默认模型真实本机调用并保留诚实边界。
- [ ] T6：完成全仓 QA、敏感内容扫描、375/390/430/1440、Repository Policy、PR 与 Preview；生产保持 manual-pending。
- [ ] T7（二期）：用户手动添加 Agent registry。真实注册表写控制面数据库（优先 D1，必要时 PostgreSQL），浏览器只保存表单草稿、最近选择和 UI cache；API key、模型权重、私有 endpoint 不进入浏览器存储或公开 Evidence。
- [ ] T8（二期）：补生产级性能降级。参考 Web3 作业交付口径，但只落在 Agent Market：Evidence 图表/截图懒加载，弱网/低端设备进入 `degraded` 轻量模式，慢接口统一超时/退避/局部降级，性能异常写入用户可见降级提示，并在 Preview Web Vitals 与 Evidence 中留痕。
