# Live Agent 协议交接包

## 复用边界

Personal AI 后续只复用协议、边缘网关、Tunnel 和 Runtime 接口，不复用 Agent Market 的任务、押金、仲裁、市场文案。

## Schema 与类型位置

- 共享契约：`packages/shared-contracts/src/local-agent.ts`
- Web catalog：`apps/web/src/agentCatalog.ts`
- Edge gateway：`apps/web/src/pages-worker.ts`
- Local Runtime：`apps/local-agent-runner/src/stream-runtime.ts`
- Provider adapter：`apps/local-agent-runner/src/provider-api-client.ts`、`apps/local-agent-runner/src/provider-adapters.ts`

## Catalog endpoint

- `GET /agent/catalog`
- 返回 `schemaVersion=agent-market.catalog.v1`
- 返回内容只包含公开安全字段：`id`、`displayName`、`provider`、`ownership`、`modelTag`、`modelDigest`、`capabilities`、`verification`、`source`、`license`、`readinessScore`、`verifiedOperations`、`note`
- 不返回 API key、shared secret、cookie、本地路径、模型权重、完整敏感 prompt 或 Ollama 端口。

## Provider capability 字段

- `completion`：普通文本对话或节点输出。
- `reasoning`：适合 Judge、Planner、Final Arbiter。
- `code`：适合代码计划、脚手架、修复。
- `fast-draft`：适合低成本初稿或候选生成。
- `long-context`：适合长文档节点，必须另配 payload 与成本上限。
- `vision`：候选能力，当前 Agent Market 仍需独立视觉 adapter smoke。
- `local-runtime`：只能经本机 Runtime 调用，浏览器不能直接访问。

## Health 与 readiness 语义

- `online`：runtime/provider 可达，并有当前正向 readiness 证据。
- `degraded`：adapter 或凭据存在，但当前模型没有完整 live readiness 证据。
- `offline`：runtime 未配置、不可达，或模型不能被 live work 选择。
- `verification=verified`：有当前 Agent Market smoke 或等价证据。
- `verification=pending-smoke`：catalog 可见，但不能写成线上可用。
- `verification=pending-credential`：需要用户配置或轮换 provider key。

## 错误码

- `VALIDATION_FAILED`
- `FORBIDDEN`
- `REQUEST_TOO_LARGE`
- `TURNSTILE_FAILED`
- `RUNTIME_OFFLINE`
- `UPSTREAM_TIMEOUT`
- `MODEL_UNAVAILABLE`

## 脱敏约束

- 前端无 AWS、provider API、Ollama、Runtime shared secret。
- Evidence 不保存 key、cookie、私有路径、模型权重、训练数据原文或完整敏感 prompt。
- Provider 模型只能记录公开 tag、provider、能力、验证状态和脱敏 smoke 结果。
- Local Ollama 固定在 `127.0.0.1` runtime 边界后；公网只到 Worker/Tunnel 的受控 API，不暴露 `11434`。
