# Agent Market 本地 Ollama Agent 需求

## 目标

把训练任务产出的 `personal-ai-agent-runtime:v4.1` 自动注册为 Agent Market 默认本地 Agent。Agent Market 保持云端控制面，本机 Mac 只作为主动出站的算力节点，不作为公开服务器。

补充接入 DeepSeek、Kimi、Qwen 与 Zhipu API key 时，它们必须作为 `third-party/provider-api` Agent 接入 runner，不能写成本地模型或自训练成果。

用户确认 V1 采用多 agent 报名后的 C 方案：真实网页对话走 Cloudflare Worker + Tunnel + 本地 Stream Runtime；现有 Local Agent Runner 继续承担身份、manifest、heartbeat、lease、result 与 Evidence 控制面。

## 用户可见结果

- Agent Market 的 Local Agents 页面默认选中 `personal-ai-agent-runtime:v4.1`。
- 页面明确标记该模型为 `owner-trained`，展示 tag、digest、Q4_K_M、8.2B、40960 context 和最近验证时间。
- 其他 allowlist 模型可作为 `third-party/local-served` 节点出现，并展示来源与 License 状态；没有来源证据时必须显示 `pending metadata`。
- DeepSeek/Kimi/Qwen/Zhipu 作为外部 provider API 节点出现，展示 provider、模型 ID、凭据边界和最近验证状态；API key 不进入浏览器、仓库或 Evidence。
- `/agents/local` 页面采用类似 Mastra 的 Agent playground：左侧 Agent 列表，右侧真实聊天面板，支持本地 owner-trained 模型和 DeepSeek/Kimi/Qwen/Zhipu provider API。
- 本机 runner 在线时自动注册并发送 heartbeat；退出或超时后控制面显示 offline。
- 公开页面不得直接请求 `localhost:11434`，也不得把静态快照冒充实时在线状态。

## Runner 要求

- Ollama origin 固定校验为 `http://127.0.0.1:11434`，拒绝 `0.0.0.0`、LAN IP、域名和公网 URL。
- 启动时调用 `/api/tags` 与 `/api/show`，只注册 allowlist 中已安装的 chat-capable 模型。
- 启动时可读取 `DEEPSEEK_API_KEY` 与 `MOONSHOT_API_KEY`，将可用 provider 注册成 `third-party/provider-api`；无 key 时显示 `offline` 或 `not configured`，不伪造在线。
- embedding 模型不得注册为聊天 Agent。
- 默认并发为 1，可配置但上限为 2；单任务默认超时 120 秒。
- 支持 AbortSignal 取消、SIGINT/SIGTERM 优雅停止、重复 lease 幂等和失败隔离。
- 日志只记录 request_id、run_id、agent_id、阶段、耗时、结果状态和错误码，不记录 prompt、完整回答、凭据或模型权重路径。

## Agent 注册契约

Manifest 必须包含：

- `id`、`displayName`、`ownership`、`provider`；
- `capabilities` 与 `toolSchemas`；
- `model.tag`、`model.digest`、family、parameter size、quantization、context length、source、license；
- `health.status`、`lastHeartbeatAt`、`lastVerifiedAt`；
- `limits.maxConcurrency`、`timeoutMs`、`maxPayloadBytes`。

模型不能直接注册，必须由 runner 的 Agent adapter 包装。任务必须绑定 `requestId`、`runId`、`taskId`、`agentId`、model tag 与 digest。

## 控制面协议

本期冻结并实现以下 HTTP client 契约与本地 mock 验证，不部署云资源：

1. `POST /v1/local-agents/register`
2. `POST /v1/local-agents/{agentId}/heartbeat`
3. `POST /v1/local-agents/{agentId}/leases:next`
4. `POST /v1/local-agent-results`

控制面返回空 lease 时 runner 退避；控制面不可用不影响 Agent Market 主站；云端真实持久化和生产路由状态为 `pending-cloud`。

## 线上对话协议

V1 新增可复用 Live Chat 协议，供 Agent Market 和后续 Personal AI Agent 共用：

1. Browser -> Worker：`POST /agent/chat`，请求包含 `requestId`、`idempotencyKey`、`agentId` 和短消息数组。
2. Worker -> Local Runtime：`POST /agent/chat`，Worker 对 body 做 SHA-256/HMAC 签名，Runtime 验签后才执行。
3. Runtime -> Browser：`text/event-stream`，事件为 `meta`、`delta`、`done`、`error`。
4. Health：`GET /agent/healthz`，只返回 `online|degraded|offline`、公开 Agent 身份和错误码，不返回本地端口、路径、密钥或权重信息。

Worker 负责 CORS、输入大小、Turnstile 可选验证、Runtime 超时和统一错误码。Tunnel 只允许转发到本地 Runtime 受控端口，绝不转发 `11434`。

## 安全要求

- 每个请求包含 key id、Unix timestamp、nonce、body SHA-256 和 HMAC-SHA256 签名。
- 验证端使用 timing-safe 比较，拒绝过期时间窗、重复 nonce、body hash 不一致和未知 key id。
- Worker 到 Runtime 的 live chat 请求也必须签名；Tunnel 不是授权边界。
- 凭据只从进程环境或本机安全存储注入，不进入浏览器、仓库、Evidence 或日志。
- DeepSeek/Kimi/Qwen/Zhipu key 只允许存在于本地 ignored env、shell 环境或将来的 Cloudflare secret/AWS secret；本期优先本地 runner 使用。
- 请求与结果 payload 均有字节上限；prompt 和输出都按 schema 限长。
- 不上传完整模型权重、训练集、系统 prompt 或 Ollama Modelfile。

## Evidence 要求

- 全局架构图：云控制面、出站 runner、localhost Ollama 和签名结果边界。
- C 方案仲裁图：Worker/Tunnel/Local Runtime 的同步聊天数据面与 Runner/control-plane 的异步控制面分开画。
- Provider API 图中必须把 DeepSeek/Kimi/Qwen/Zhipu 画在 runner 出站侧，明确它们不是本地权重、不是自训练模型。
- 编号时序图：发现、注册、heartbeat、lease、推理、结果、offline。
- 自动注册 manifest 的脱敏快照。
- 一次真实 `personal-ai-agent-runtime:v4.1` 本机调用，保留原始模型回答但只公开安全、短小的代表性内容。
- 一次 DeepSeek、Kimi、Qwen 与 Zhipu provider API smoke 只记录 provider、model、requestId、时间、结果摘要，不记录 key 或完整敏感 prompt；其中 Kimi 在有效凭据前必须标记为 `pending-credential`。
- mock online→task→result、重复任务幂等、超时/失败、offline 测试证据。
- 所有状态区分 `implemented`、`verified-local`、`pending-cloud`、`planned` 和 `offline`。

## 发布边界

- 不启动或修改 AWS。
- 可创建 PR 和 Cloudflare Preview；不发布生产。
- 正式控制面上线、短期凭据签发与云端在线状态属于后续显式授权节点。

## 验收

- Runner 单元、协议、mock Ollama 和集成测试通过。
- Live Chat 协议、Runtime、Worker proxy 和 Mastra-style 页面测试通过。
- 一次真实本机 smoke 通过，默认模型 tag/digest 与 manifest 一致。
- 浏览器构建产物不包含 `11434`、HMAC key 或本机私有路径。
- 375、390、430、1440 页面无根级横向溢出，触控目标至少 44px。
- 根 verify、typecheck、build、Evidence Gate、Repository Policy 和远端 Gate 通过。
- 最终状态明确写为 `production: manual-pending`。
