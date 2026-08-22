# Agent Market 本地 Ollama Agent Tasks

- [x] T1：冻结 Requirements、Design、Contract、Tasks 和实施计划，建立共享 Agent Manifest/Lease/Result schema 与测试。
- [x] T2：实现 loopback-only Ollama client、DeepSeek/Kimi/Qwen/Zhipu provider API client、模型自动发现、owner-trained/third-party adapter、超时取消和安全 metadata。
- [x] T3：实现 HMAC 签名/验签、重放保护、控制面 HTTP client、幂等 runner、heartbeat/offline 和 mock 全链测试。
- [x] T4：新增 `/agents/local` 双语响应式页面，把 `personal-ai-agent-runtime:v4.1` 设为默认本地 Agent，并展示 DeepSeek/Kimi/Qwen/Zhipu provider API 节点；浏览器不直连 Ollama 或 provider key。
- [x] T4b：按 C 方案新增 Live Chat 协议、Worker `/agent/chat`/`/agent/healthz`、Local Stream Runtime 和 Mastra-style playground。
- [ ] T5：生成架构图、时序图、manifest 与 mock/真实 smoke Evidence；运行一次默认模型真实本机调用并保留诚实边界。
- [ ] T6：完成全仓 QA、敏感内容扫描、375/390/430/1440、Repository Policy、PR 与 Preview；生产保持 manual-pending。
