# Agent Market 真实 Agent 闭环增量需求

日期：2026-08-26

基线：`docs/superpowers/specs/2026-08-22-agent-market-local-ollama-agent/`

Contract：`9fa2fa5a1bf2d6774b4fa07a21af114ef4dbb75f628907cfe1a52fc36de0e927`（v2）

## 1. 目标

在不新增 AWS 付费资源、不发送链上交易、不发布生产的前提下，关闭 Agent Market 真实 Agent 数据面的本地闭环：

1. 通过 Agent Market 签名 Runtime 分别调用 `personal-code-agent:v1` 与 `personal-image-agent:v1`。
2. 证明 Queen GraphQL 工作流的成功、Provider 失败、超时和用户取消均进入明确终态。
3. 证明本地 Agent 默认仅 Owner 可选，公开调用不能绕过访问边界。
4. 所有确定性 Gate 通过后，重新录制完整功能流程并生成脱敏 Evidence。

## 2. 明确不做

- 不拉取、删除或重新训练 Ollama 模型。
- 不开放 `11434`、本地文件、终端、工具执行或模型权重。
- 不创建或修改 AWS 资源。
- 不发送 Sepolia 交易。
- 不发布生产；本轮最多发布 Preview。
- 不把 Evidence 作为 DAG 业务节点。
- 不恢复 Mastra 依赖。

## 3. 模型身份

### Personal Code Agent

- Agent ID：`personal-code-agent`
- Tag：`personal-code-agent:v1`
- Ollama digest：`4b9c60671fff53a198630f9aaf6b76d7d46c356359f41030f52e61f77f7b83bb`
- 基座：Qwen3-8B，revision `b968826d9c46dd6066d109eabc6255188de91218`
- 量化：`Q4_K_M`
- Context：`8192`
- License：Apache-2.0
- Ownership：`owner-trained`
- 能力：`code-planning`、`implementation-plan`、`verification-gates`、`structured-json`、`local-runtime`

### Personal Image Agent

- Agent ID：`personal-image-agent`
- Tag：`personal-image-agent:v1`
- 当前 Ollama manifest digest：`2fa405e1244629244798cb4d7b8f4b3a5dd9e47aaf9ea7329e8dbe27bd32cffd`
- GGUF SHA-256：`4bba2f8f38a08edb2ad74a9a7b1a8927d5df4c31e7ec6270a6bdb3309706bfba`
- 基座、revision、量化、Context、License、Ownership 与 Code Agent 相同。
- 能力：`image-brief`、`asset-manifest`、`visual-quality-gates`、`structured-json`、`local-runtime`

只有 `ollama list/show` 与 Agent Market 自身签名 smoke 同时匹配时，状态才可从 `MODEL READY / AM PENDING-SMOKE` 升级为 `VERIFIED-LOCAL`。

2026-08-26 只读核验确认：历史公开说明中的 `59de6282…` 没有一手 Ollama manifest 产物支持，属于陈旧或误录值。当前 tag manifest 文件 SHA-256 与 `/api/tags` 均为 `2fa405e1…`，其 model layer 与验收 GGUF SHA-256 `4bba2f8f…` 一致；Registry 必须使用当前 manifest digest，不能用历史值绕过身份 Gate。

## 4. 可测成功标准

| 维度 | Gate |
| --- | --- |
| 正确性 | 两个模型都通过 Agent Market HMAC Runtime 返回符合节点契约的 JSON；tag 与 digest 精确匹配。 |
| 安全 | 公开 caller scope 选择 Owner-only Agent 返回 `FORBIDDEN`；浏览器产物、日志与 Evidence 不出现密钥、`11434`、私有路径或完整敏感 Prompt。 |
| 可靠性 | GraphQL 成功、Provider 失败、超时、取消四种路径都只有一个明确终态；重复请求不重复执行。 |
| 独立验收 | Execute、Judge、Final Arbiter 使用不同 Agent 身份与隔离上下文；同一模型不得占据三选一中的多个位置。 |
| 延迟 | 记录每次 smoke 的总延迟；工作流单个 GraphQL 操作不超过 45 秒，模型调用沿用 Runtime 受控超时。 |
| 成本 | 本地模型增量推理成本记为 0 美元；Provider smoke 默认使用 mock，真实 Provider 调用需单独记录。 |
| 用户反馈 | UI 对 running、succeeded、error、cancelled 显示可见反馈，并允许用户取消。 |

## 5. 编排约束

- `/agent/graphql` 是真实多 Agent 编排唯一入口。
- LangGraph 管理 DAG 状态、修改、确认、锁定、失败路由、补救和恢复。
- LangChain 只在节点内确有模型、Prompt 或 Tool 组合时使用；不得为展示框架而接入。
- Queen 可规划和协调，但不能担任 Judge 或 Final Arbiter。
- Judge 必须与被审 Agent 身份不同且上下文隔离；Final Arbiter 也必须独立。
- 候选先按权限、健康、能力、License/Tag 和任务 Tags/分类硬过滤，再评分。
- 三选一候选按 `modelTag` 去重。
- Red Team 与 Repair 是按风险或失败追加的版本化节点，不要求常驻页面。

## 6. 终态与失败语义

- `succeeded`：所有确定性 Gate 通过，Judge 与 Final Arbiter 完成。
- `error`：Provider、Schema、权限或执行失败；必须保留安全 reason code。
- `timeout`：服务端或客户端截止时间触发；不得显示为成功。
- `cancelled`：用户取消信号生效；后续节点不得继续执行。
- Runtime 或 Ollama 离线时页面保持可用并显示 `offline/degraded`。

## 7. Evidence

- Evidence 是旁路审计输出，不进入业务 DAG。
- 输出两个 owner-trained 模型的脱敏 manifest、tag/digest 匹配、签名 smoke 摘要和延迟。
- 输出 GraphQL 四种终态的测试或运行台账。
- 录屏必须在确定性 Gate 通过后重新生成，覆盖钱包连接、Agent 注册/维护、任务发布草稿、DAG 自动生成与手动改派、工作流终态、仲裁反馈、质押页面和 Evidence。
- 录屏不发送链上交易；未验证能力必须在画面和台账中保持 pending。

## 8. 发布边界

- 本地验证和 Cloudflare Preview 可自动执行。
- 生产发布、生产配置、AWS 付费资源、Sepolia 交易和破坏性操作必须在动作前再次获得授权。
