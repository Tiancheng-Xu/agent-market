# Agent Market 外部闭环一次性授权矩阵

日期：2026-08-26  
目标环境：Ethereum Sepolia、AWS `us-east-1`、Cloudflare Preview/Production Readback  
当前状态：本地 Gate 与 AWS 非 Root 只读盘点已完成；本文不代表已更新 AWS 工作负载、已发链上交易或已取得 V2 全链外部回读。

## 不可突破的边界

- 不升级、转换或取消 AWS Free 账户计划，不加入 AWS Organizations，不启用 Control Tower，不关闭账户。
- AWS Root 仅完成一次 IAM Bootstrap 权限补齐后已退出；只读盘点和后续允许的 AWS 操作必须使用 MFA 保护的 `AgentMarketOperatorRole`，Root 不再参与。
- 不创建第二套 NAT Gateway、RDS/Aurora、ALB、ECS Cluster、OIDC Provider 或共享日志/制品基础设施。
- Sepolia 只使用测试 ETH 与测试 YD；不存在真实收益或真实资产承诺。
- 不公开私钥、助记词、API Key、Cookie、内部路径、完整 Prompt、模型权重或训练数据。
- 每个外部动作都绑定 `request_id`、交易哈希或部署标识；没有外部回读就不能标记 `verified-production`。

## AWS 复用与成本矩阵

| 资源 | 现有候选 | 决策 | 隔离方式 | 本次增量成本与上限 | 清理/回滚责任 |
| --- | --- | --- | --- | --- | --- |
| VPC / Subnet / Route / NAT / IGW | 已验证共享 VPC、2 个私有子网、2 AZ、1 个既有 NAT、0 个 VPC Endpoint | 必须复用 | 项目 Security Group 与最小入站规则 | 禁止新增第二个 NAT 或重复网络 | 平台保留，不删除 |
| PostgreSQL / pgvector | 已验证私有 `db.t4g.micro` PostgreSQL，可用、加密、删除保护、单 AZ、备份 1 天 | 必须复用 | 项目独立 Schema/Role | 仅既有实例增量负载 | 只清理项目 Schema，不动引擎 |
| ECS Cluster | 已验证项目 Cluster 为 ACTIVE，当前 service/task 均为 0 | 必须复用 | 项目 Task Definition、标签、短时任务 | 单次短时 Fargate 运行 | 任务结束后验证 running=0 |
| ECR | 现有项目仓库 | 复用 | 不可变镜像 Tag | 少量镜像存储/拉取 | 保留仓库；不删除共享镜像 |
| API Gateway / Lambda | 已验证 1 个 HTTP API 与 2 个 Active Lambda；部署态仍缺 HMAC，API access log 关闭 | 仅原位更新 | HMAC、限流、项目路由、IAM、日志前缀 | 单样本请求与短时执行 | 回滚版本/别名，关闭摄取入口 |
| SNS / SQS / DLQ | 已验证 1 Topic、工作队列与 DLQ；SSE 开启、队列均为 0、消费映射 Disabled | 必须复用 | `request_id` 幂等与 DLQ 隔离 | 单条消息级按量费用 | 禁用 Event Source Mapping；不清空队列 |
| CloudWatch | 已验证 4 个日志组，但部署态均无保留期 | 复用并收敛到短保留期 | 脱敏原因码与 7 天保留期 | 单样本日志量 | 不删除共享日志，回滚时保持有界保留 |

AWS 本轮硬预算：只允许一条生产验证样本；若动作前估算的新增 AWS 费用可能超过 **USD 0.10**，立即停止并重新申请授权。该上限是执行保护，不是费用承诺。

## AWS 拟执行动作

1. 已完成：使用 MFA 非 Root `AgentMarketOperatorRole` 只读盘点现有 Stack、VPC、数据库、ECS、ECR、API、Lambda、SNS、SQS、DLQ 与 Event Source Mapping；脱敏结果见 `docs/evidence/deployment/2026-08-27-aws-v2-readonly-inventory.json`。
2. 对本地 IaC 运行共享资源 Gate，确认没有复制 Foundation。
3. 仅在现有工作负载确有缺口时更新 `agent-market-performance`；禁止创建新的共享 Foundation。
4. 临时启用受限消费端，发送一条 UUIDv7 + HMAC 的浏览器性能样本。
5. 回读同一 `request_id` 的 API Gateway、Lambda、SNS、SQS、ECS 与 PostgreSQL 记录。
6. 发布脱敏 Evidence 后立即恢复暂停：Event Source Mapping Disabled、ECS running=0、DLQ 状态已读回。

AWS 回滚：禁用 Event Source Mapping，必要时把 Lambda reserved concurrency 设回暂停值；不删除队列、不清空消息、不删除共享资源。

## Sepolia V3 增量部署矩阵

| 对象 | 处理 | 原因 | 权威证据 |
| --- | --- | --- | --- |
| 既有 `YDToken` | 复用；部署前只读验证 bytecode 与 `totalSupply()` | 避免重复发币与错误地址 | RPC code/ABI 探针 |
| `TaskStakeReceipt` | 新部署一次 | 任务临时质押份额凭证 | deployment receipt |
| `AgentMarketWorkflowEscrow` | 新部署一次 | V3 任务、6% 平台押金、DAG 锚定、Agent 份额与单一平台仲裁 | deployment receipt |
| Receipt `configureEscrow` | 仅配置一次 | 把铸造/销毁权限绑定 V3 Escrow | transaction receipt |
| V2 Committee | 不改、不重部署 | 只保留历史 Evidence；V3 使用单一平台最终仲裁人 | 版本边界说明 |

平台最终仲裁人使用用户指定的 Chrome MetaMask Account 1；执行时只把其公开地址写入部署参数，不公开钱包标签、账户资料或签名上下文。

Sepolia 本轮拟执行动作：

1. 部署 Receipt 与 Workflow Escrow，配置 Receipt。
2. 更新 Web/Transaction Engine 的公开合约地址配置。
3. 网页连接 MetaMask，授权 `预算 + 固定 6% 平台发布押金`，发布任务并验证 `TaskCreated` 回执。
4. Queen 生成 DAG，用户可修改后确认；上链锚定 `workflowId + dagHash + version`。
5. 自动匹配/接单并锚定节点与 Agent 身份；执行后由独立 Judge 检查，平台最终仲裁人按规则裁决。
6. 验证 Agent 质押份额领取；用户自己的 Agent 份额在任务完成后退还。
7. 网页执行 YD approve、stake、部分/全部 unstake、claimYield，并分别回读 receipt、event、position 与 reward reserve。

Sepolia 失败回滚：停止后续交易并保留已发生的测试网回执；不伪造成功、不删除历史链上记录。尚未配置进 Web 的新合约不影响既有 V2 页面。

## 一次性授权所覆盖的动作

用户在动作边界明确确认后，本轮授权可一次性覆盖：

- 使用 **非 Root** AWS 身份完成上述只读盘点、必要的现有工作负载更新、单样本全链验证与可逆暂停。
- 使用 Chrome MetaMask Account 1 在 Sepolia 完成 V3 两个合约部署、一次配置和上面列出的任务/仲裁/质押测试交易。
- 将脱敏部署标识、交易哈希、状态、事件和截图写入项目 Evidence，并发布 Preview；生产发布仍按最终 Gate 单独确认。

以下不包含在授权内：AWS 账户计划变更、Root 写操作、新共享基础设施、主网交易、真实资金、破坏性删除、公开密钥或生产自动发布。

## 通过标准

- 所有本地测试、类型检查、构建、仓库策略、secret/PII 扫描通过。
- AWS 同一 `request_id` 可从浏览器追踪到 PostgreSQL，并证明消费端重新暂停。
- Sepolia 每一步都有 status=1 的精确 receipt、目标合约地址及匹配事件；失败路径明确展示失败。
- 新版录屏覆盖钱包连接、Agent 注册、任务发布、DAG 修改、自动接单、运行终态、平台仲裁、任务份额、质押/解押/领取和 Evidence 回读。
- Evidence 只展示进行中或已完成事实；计划项、旧录屏和旧 V2 委员会流程不得冒充 V3 完成。
