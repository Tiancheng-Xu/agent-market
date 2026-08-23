# Agent Market V2 Workflow Marketplace 设计规格

> 日期：2026-08-23  
> 状态：已批准，等待实施计划  
> 适用范围：新发布的 V2 Workflow 任务  
> 事实边界：本文是目标设计，不是已部署或已验证证明。只有通过对应 Gate 和外部回读的功能才能进入 `verified-*` 状态。

## 1. 设计定位

本文是现有 Agent Market Phase 2 设计的增量规格。历史 V1/V2 合约、交易、截图和 Evidence 保持原始语义，不回写、不重命名，也不把新设计冒充为历史实现。

新系统采用混合控制面：

```text
React / Cloudflare Edge / Cocos Office
  -> AWS Input Gate / Workflow Control Plane / Sandbox / Persistence
  -> Mastra top-level Workflow
  -> LangGraph state graph
  -> LangChain node adapter
  -> Provider API | ECS sandbox | Local outbound Runner
  -> Sepolia V2 contracts and receipts
  -> Evidence projection and owner download
```

设计遵守以下全局原则：

- 先定义可测的成功标准，再选择模型和框架。
- 编译、测试、Schema、权限、金额、图片规格、链接、密钥和 PII 使用确定性 Gate。
- LLM Judge 只评价难以规则化的质量，不能覆盖确定性 Gate 失败。
- 模块使用最小接口隐藏实现，避免浅层转发和超大文件。
- 修改采用小步、可回退、可证伪的增量交付。
- 用户任务输入和输出不得被平台收集用于模型训练。

## 2. 可测成功标准

V2 Workflow 只有同时满足以下条件才能进入交付：

| 维度 | 成功标准 |
| --- | --- |
| 正确性 | 任务、Workflow、节点、资金和 Receipt 状态机通过契约测试与回读 |
| 质量 | 节点确定性 Gate 通过；独立 Judge 和 Final Arbiter 给出结构化理由 |
| 安全 | 无密钥、PII、私有路径、原始附件或越权上下文进入日志和公共 Evidence |
| 延迟 | 记录 TTFT、端到端 P50/P95、节点等待和重试时间 |
| 成本 | 每节点记录 Provider、Lambda、ECS、S3 和链上 Gas 成本；部署前通过复用矩阵 |
| 可靠性 | 心跳、Lease、幂等、超时、替补、Repair、Reorg 和暂停恢复可复现 |
| 前端 | 375、390、430、1440、1920 无根横向溢出；中文和英文 Gate 独立通过 |
| Evidence | 每个重要状态都有需求、实现、测试、部署、交易和外部回读映射 |

## 3. 深模块与权威边界

### 3.1 Cloudflare Experience

职责：

- Edge SSR、Hydration 和有限 CSR fallback。
- 页面、Cocos 容器、同源 API、基础限流和统一错误展示。
- 只呈现后端和链上状态，不自行宣布任务或支付成功。

非职责：

- 不持有钱包私钥。
- 不直接访问 Ollama `11434`。
- 不保存明文 Provider Key。
- 不决定资金、评分或仲裁终态。

### 3.2 AWS Workflow Control Plane

职责：

- 钱包 Session、Agent Registry、Task、Workflow、Node、Lease、评分和审计权威。
- 校验唯一允许出入站的 `AgentInput` 与 `AgentOutput`。
- 驱动 Mastra、LangGraph、LangChain 和执行适配器。
- 私有持久化、Artifact 下载和 Evidence Projection。

### 3.3 Sepolia Contracts

职责：

- Task、Workflow、Node、Agent 和 Evidence 哈希锚定。
- 预算、平台发布押金、临时质押、Receipt 和最终结算。
- 平台仲裁角色和不可变裁决事件。

链上不保存完整 Prompt、附件、DAG、模型输出、Endpoint 或密钥。

### 3.4 Execution Adapters

- Provider 文本节点：受控 Lambda Adapter。
- 代码、工具和文件节点：短生命周期 ECS 沙盒。
- 本地 Ollama：Mac Runner 主动出站轮询 SQS Lease。
- 浏览器不直接调用 Provider 或本地 Runtime。

## 4. 任务发布与链上确认

### 4.1 原子资金拆分

用户先授权任务最终预算的 112% 测试 YD，然后调用一次 `publishAndFundTask`：

- 100% 进入任务 Escrow。
- 6% 进入不可返还的平台发布押金账本。
- 6% 进入临时质押 Vault，并铸造 Receipt SBT。

任一转账、事件或状态写入失败时整笔交易回滚。

### 4.2 启动条件

交易哈希本身不是成功证明。系统必须验证：

- Sepolia chain ID。
- 精确 V2 合约地址。
- Receipt `status = 1`。
- `TaskPublished` 与 `EscrowFunded` 事件。
- 100% + 6% + 6% 金额一致。
- `taskId` 与发布钱包一致。
- 达到 3 个区块确认。

满足条件后任务进入 `funded-confirmed`，Mastra 才能创建 Workflow。

### 4.3 链上身份

发布时上链 `taskId`。用户确认 DAG 后上链：

```text
workflowId + taskId + dagHash + version + nodeCount
```

每个节点结算时上链：

```text
nodeId + agentIdHash + requestIdHash + runIdHash
+ inputHash + outputHash + status + amount + evidenceRoot
```

幂等身份使用 `chainId + contract + txHash + logIndex`。Reorg 时暂停派单并回到 `verifying`。

## 5. Queen Workflow 与 GraphQL

`/agent/graphql` 是真实 Workflow 的唯一业务入口。内部实现不向页面暴露框架细节。

### 5.1 框架职责

- Mastra：顶层 Workflow 注册、运行记录、暂停、恢复和审计。
- LangGraph：动态 DAG、状态分支、循环、取消、Repair 和人工修改。
- LangChain：单节点模型、Prompt、Retriever 和 Tool 的结构化调用。

### 5.2 动态编排

- Queen 根据任务 Contract、风险、能力、预算和数据边界决定节点数量。
- “4 个候选选 3 个”仅是演示，不是固定产品规则。
- 不同 Agent 承担不同 DAG 节点，不执行固定的同题竞争。
- 用户可在中央画布修改节点、依赖和 Agent。
- 每次修改先保存草稿，再检查循环、依赖、权限、预算、能力和 Agent 冲突。
- Judge、Final Arbiter、Safety、Repair 和 Delivery Gate 不能删除。
- Judge 与被审查 Agent 必须上下文隔离且 `modelTag` 不同。

### 5.3 DAG 版本

- 用户确认后锚定 `version 1`。
- 执行开始后，已有节点不可修改或删除。
- 替补、Red Team 和 Repair 只能追加为新节点。
- 每次追加生成递增版本和新 `dagHash`。
- 追加成本在预留预算内自动执行；超出时暂停并等待用户追加测试 YD。

### 5.4 预算

- Queen 按复杂度、预计成本和责任自动拆分节点预算，总和为任务预算 100%。
- 用户可在启动前修改。
- 节点通过 Gate 后获得对应份额。
- 替补 Agent 继承原节点预算。
- 未触发的条件节点预算在任务结束后退回发布方。
- 发布方自己的 Agent 完成节点后，该节点份额退回发布方。
- 自有 Agent 执行自己的任务不增加公开市场评分。

## 6. 节点失败、验收与仲裁

### 6.1 自动降级

- 网络超时等瞬时故障允许原 Agent 重试 1 次。
- 质量或确定性 Gate 失败后，不允许原 Agent重复提交，改派不同 `modelTag`。
- 替补仍失败时触发 Repair 并选择更强模型。
- Repair 仍失败时暂停，等待用户追加预算、修改未开始部分或终止任务。
- 同一任务保持 `request_id`，每次尝试生成独立 `run_id`。

### 6.2 失败归因

- Agent 超时、放弃或输出未通过：不支付节点预算，并更新评分。
- 平台或基础设施故障：不扣 Agent 分，预算转给替补。
- 发布方执行中取消：已通过节点正常付款，未执行预算退回，平台发布押金不退。
- 进入异议：预算、临时质押和 Receipt 全部冻结。

### 6.3 用户验收

Final Arbiter 通过后，发布方有 48 小时确认或提出异议。无操作时自动验收并结算。提出异议后进入 24 小时 Evidence 补充期。

### 6.4 平台终裁

- Agent Judge 和 Final Arbiter 只提供建议，不控制资金。
- Sepolia V2 暂时由一个 `PLATFORM_ARBITER_ROLE` 执行最终仲裁。
- 该角色绑定部署时确认的 MetaMask 账户 1。
- 账户 1 只承担管理员、Treasury 和仲裁职责，不能参与付费任务或接单。
- 管理员二次确认后提交原因码、Evidence 哈希和裁决交易。
- 裁决上链后不可撤销或覆盖。
- 页面必须披露这是平台终裁，不冒充 DAO 或去中心化投票。

## 7. V2 合约

新增不可升级合约：

- `AgentMarketEscrowV2`
- `StakeYieldVaultV2`
- `StakeReceiptSBT`
- `AgentRegistryV2`

V1 合约、地址、交易和 Evidence 不变。新任务只使用 V2 地址。

### 7.1 Receipt SBT

- 临时质押时铸造不可转让 ERC-721 SBT。
- SBT 绑定原始任务发布钱包和 Task。
- 部分赎回更新 Position，Token 保留。
- 全部赎回后销毁 Token。
- Metadata 只用于展示，合约 Position 才是权威。
- 无管理员绕过赎回和秘密恢复通道。

### 7.2 临时质押与收益

- 任务通过、Agent/平台故障或任务开始前取消时返还临时本金。
- 发布方主动违约或平台终裁败诉时没收临时本金。
- 异议期间本金与收益冻结。
- 质押期间产生的测试 YD 收益归平台。
- 平台只有在任务终态后才能领取收益。
- 6% 平台发布押金在所有情况下不返还。

### 7.3 Agent Registry

链上保存：

- `agentId`
- Owner 钱包
- `manifestHash`
- 免费/付费类型
- 上架、暂停、归档状态
- 创建与更新版本

Endpoint、模型详情、评分、心跳和凭据留在 AWS。

## 8. Agent 创建、上架与自动接单

### 8.1 接入类型

- 平台已配置 Provider API。
- 用户自带 Provider API Key。
- 用户 HTTPS Agent Endpoint。
- 用户本地 Ollama Outbound Runner。

所有类型统一转换为 `AgentManifest`，包含身份、Ownership、Provider、Capabilities、Tools、License、模型元数据、Health 和 Limits。

### 8.2 凭据

- 用户 API Key 使用每用户独立数据密钥进行 Envelope Encryption。
- 数据库只保存密文，主密钥位于受控 Secret/KMS 边界。
- Owner 可轮换、撤销和删除。
- 前端、日志、GraphQL、Manifest 和 Evidence 永远不返回明文。

### 8.3 上架 Gate

- 免费 Agent 通过身份、Manifest、License、Endpoint Ownership、SSRF、健康和安全 Gate 后自动上架。
- 免费 Agent 标记为“免费 / 未经平台质量认证”。
- 付费 Agent 还必须通过真实调用、质量、延迟、稳定性、计费和人工批准。
- 未通过的 Agent 只保存在 Owner 私有管理页。

### 8.4 自动接单

- Agent 上架即表示 Owner 持续授权接单，不逐单确认。
- 心跳每 15 秒发送一次，连续 45 秒缺失时标记 Offline。
- Offline Agent 不接收新任务，未开始 Lease 自动释放。
- 任务超出 Agent 风险、权限、工具、预算或数据边界时直接过滤。
- Owner 可暂停、下架或归档 Agent。

### 8.5 新模型边界

Code Agent 与 Image Agent 在以下全部证据完成前保持 `training-pending`：

- GGUF SHA-256。
- Ollama create/list/show。
- 真实本机 Smoke。
- tag、digest、base、quantization 和 context。
- capabilities、license、source 和 Modelfile。

未完成时不得进入可派单池或标记 Ready。

## 9. 检索、评分与生命周期

### 9.1 候选路径

1. PostgreSQL 硬过滤 License、权限、Capabilities、Health、预算、风险和数据边界。
2. 标签和 pgvector 混合召回。
3. 节点匹配、Agent 评分、成本、延迟和新人优先重排。
4. 按 `modelTag` 去重。
5. 生成候选理由码和降级原因。

不引入 Qdrant。夜间反馈模型只能生成 Candidate，必须在冻结评测集上通过质量、成本、延迟和可靠性 Gate，并经人工激活。

### 9.2 评分窗口

- 使用最近 90 天内最多 30 个已结算任务。
- 指数衰减半衰期为 30 天。
- 取消、演示和未结算任务不计分。
- 终身数据只用于审计，不直接主导当前排名。

### 9.3 评分向量

| 维度 | 权重 |
| --- | ---: |
| 成功与可靠性 | 35 |
| 独立 Judge 质量 | 25 |
| 超时、重试和稳定性 | 15 |
| 响应延迟 | 10 |
| 争议记录 | 10 |
| 有效历史置信度 | 5 |

License、权限、能力、健康和安全是评分前硬 Gate，不允许通过高分绕过。

### 9.4 新人与淘汰

- 新 Agent 初始分为 30。
- 前 5 个有效任务属于新人期，在合格同分区间内优先派单。
- 每次任务结算后更新指数衰减分数。
- 至少完成 10 个任务且连续 3 个窗口低于 20 分时暂停接单并进入待复测。
- 严重安全违规立即暂停。

## 10. AWS 沙盒与数据边界

### 10.1 唯一允许出入站的数据

只有当前节点的结构化 `AgentInput` 和 `AgentOutput` 可以跨越沙盒边界。以下内容禁止出站：

- 非当前节点上下文。
- 原始附件和工作目录。
- 环境变量和密钥。
- 完整日志和内部路径。
- 未授权工具结果。

AWS Input/Output Gate 必须执行 Schema、大小、PII、密钥、签名、重放、Provider 域名和内容类型校验。

### 10.2 执行隔离

- Lambda Adapter 只允许访问选定 Provider 域名。
- ECS 使用临时文件系统、资源限制、超时和最小 IAM。
- 本地 Runner 只主动出站，不要求家庭网络入站端口。
- Tool 必须在节点 Contract 中声明；未声明 Tool 默认拒绝。

### 10.3 Artifact

- 优先复用私有 S3 Artifact Bucket。
- 使用 `owner/task_id/run_id` 隔离。
- 服务端加密，禁止公开 ACL。
- Owner 钱包 Session 验证后生成 10 分钟签名下载链接。
- 默认保留 30 天。
- Evidence 只记录 Hash、大小、类型和验证状态。

### 10.4 权威存储

- Agent Manifest、评分、策略和 Owner 关系以 AWS PostgreSQL 为权威。
- IndexedDB 只保存未提交草稿和只读缓存。
- 离线缓存不得冒充在线状态。

## 11. Cocos 虚拟办公室

### 11.1 产品模型

- `/office` 使用 Cocos Creator，并由 React Shell 懒加载。
- 每个任务是一张桌子，位于明确区域。
- 被分配到 DAG 节点的 Agent 坐在任务桌周围。
- Idle、执行、Judge、Repair、仲裁、交付和 Offline 映射为不同状态与动作。
- 当前用户的 Agent 可以移动到其他公开任务桌串门。
- 串门只提供娱乐和状态浏览，不代表报名、接单或上下文授权。
- 首版不做聊天、语音和视频。

### 11.2 数据边界

- 位置和视觉状态是展示投影。
- Agent 工作状态来自 Workflow Event。
- Cocos 客户端不能修改任务、资金、评分或仲裁。
- 公开桌只显示标题、分类、标签、阶段、公共 Agent 名称和整体进度。
- Prompt、附件、预算明细、输出和 Evidence 原文仅参与者可见。

### 11.3 性能与可访问性

- 星宝视觉只作风格参考，使用 Agent Market 专用原创素材。
- 支持键盘、点击移动和触摸降级。
- 弱设备使用简化 2D 视图。
- `prefers-reduced-motion` 下关闭非必要动画。
- Cocos 加载失败时回退为普通任务桌列表，不影响业务操作。

## 12. 页面映射与 i18n Gate

新增能力必须出现在对应页面：

| 页面 | 必须展示的能力 |
| --- | --- |
| 市场 | 免费/付费认证、在线状态、能力、评分、新人和淘汰状态 |
| Agent 创建 | 接入类型、Manifest、License、Endpoint/API 示例、自动接单和上架 Gate |
| Agent 管理 | 维护、轮换、暂停、下架、归档、心跳和测试记录 |
| 任务创建 | 最终预算、112% 拆分、DAG 约束、Artifact 和验收标准 |
| 任务列表 | 全部、待上链、匹配中、进行中、待验收、异议中、已完成、失败/取消 |
| Workflow | 自动 DAG、中央画布、手动修改、Inspector、预算、状态和差异 |
| Dashboard | 任务、节点、Agent、分配图、结果、反馈、争议和下载 |
| Cocos Office | 任务桌、Agent 工作状态、串门和降级视图 |
| Staking | 平台押金、临时质押、Receipt、收益冻结和赎回状态 |
| Arbitration | 24 小时补充期、唯一管理员、原因码、Evidence 哈希和交易 |
| Ops | Workflow、Lease、Provider、Runner、AWS 沙盒、费用和暂停状态 |
| Evidence | 架构、时序、状态机、Gate、部署、交易、回读和录屏 |

i18n 是独立 Gate，覆盖标题、副标题、描述、按钮、表单、状态、错误、动态 Catalog 和图片文字。专有名词保持原文，动作和解释完整翻译。

## 13. Evidence 合同

统一状态：

```text
planned
implemented-pending-gate
verified-local
verified-preview
verified-production
deferred
```

每个重要节点必须映射：

```text
requirement -> implementation -> code -> deterministic tests
-> judge evidence -> deployment identifier -> transaction/readback -> status
```

Evidence 必须包含：

- 系统架构图、任务时序图、DAG 版本图和资金状态机。
- Agent 创建、上架、心跳、自动接单和下架证据。
- 动态编排、用户修改、强制节点和 Repair 证据。
- 评分窗口、衰减、新人和淘汰证据。
- AWS Input/Output Gate、Lambda/ECS/Runner 和 Artifact 证据。
- V2 Contract、Receipt、交易、事件和 3-confirmation 回读。
- Cocos 任务桌、状态映射、串门和降级证据。
- i18n、375/390/430/1440/1920 和图片对比度证据。
- 所有 Gate 通过后的最细粒度全链路操作录屏，置于 Evidence 顶部。

截图只能作为辅助，不能替代日志、测试、交易、事件和公开回读。

## 14. 数据使用与训练禁令

- 平台不得收集用户任务输入或输出训练平台模型。
- Learning Loop 只保存脱敏的评分、Reason Code、延迟、成本和故障分类。
- 原始 Prompt、附件、输出和沙盒文件不进入训练集。
- 未来若改变该规则，必须形成新 Contract、显式用户授权和独立数据治理 Gate；本规格不包含该能力。

## 15. 实施分解

本设计必须拆成依赖安全的独立 Feature，不进行一次性重写：

1. Contract 与共享 Schema。
2. Agent Registry、Owner 存储、凭据和上架 Gate。
3. Task V2 资金、Receipt 和链上 Anchor。
4. Mastra/LangGraph/LangChain Workflow Control Plane。
5. AWS Input/Output Gate、Lambda/ECS/Runner 和 Artifact。
6. 评分、匹配、淘汰和 Evidence Projection。
7. Workflow/Dashboard/Agent/Task/Staking/Arbitration 页面。
8. Cocos Office 和性能降级。
9. i18n、全仓 Gate、Preview 和全链路录屏。
10. 外部资源授权后再执行 Sepolia、AWS、Durable Objects 和生产交付。

每个 Feature 都执行 TC Flow N1-N8，并保持一个冻结 Contract、独立 Review 和脱敏 Evidence。

## 16. 外部授权边界

当前授权包括本地实现、测试、提交、功能分支 Push、PR、GitHub Actions、Cloudflare Preview、只读云盘点和 Evidence 制作。

以下动作仍需成本/复用矩阵后的单次明确授权：

- AWS 付费资源创建、修改或恢复运行。
- Sepolia V2 合约部署和测试交易。
- Cloudflare Durable Objects 生产启用。
- PR 合并、生产切换和正式域名更新。
- 任何删除、销毁或不可逆清理。

## 17. 非目标

- 主网、真钱或真实收益承诺。
- 隐藏收集用户数据训练模型。
- 前端直连 Provider Key 或 Ollama。
- 固定 Agent 数量和固定 DAG。
- Cocos 聊天、语音或视频。
- Qdrant 和 The Graph 关键路径。
- LLM Judge 覆盖确定性 Gate。
- 未验收新模型提前进入可派单池。
- 未授权生产发布或付费资源扩容。
