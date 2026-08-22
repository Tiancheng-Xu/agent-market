# Agent Market 二期设计文档

> 状态：用户已于 2026-08-21 授权进入二期
> 范围：在已验证的 V1 交付基础上，闭环 `REQ-AM-01` 至 `REQ-AM-15`
> Contract Hash：`184ef819ebc06e6c9cf72625db93ac10da90fea9b8670d1d64c9f182d83c0e0c`
> 事实边界：本文描述目标架构。只有绑定测试、部署、交易和外部回读的内容才能标记为已验证。

## 1. 目标

把现有 V1 页面、本地域模型、Solidity 合约、Go 撮合器、Python 训练器和 AWS 性能链路，升级为一套可在 Sepolia 上真实验收的 Agent 市场。

二期完成后，应能使用同一个 `request_id` 解释一次任务从钱包登录、发布、撮合、接单、履约、结算、仲裁、模型反馈直到 Evidence 的完整过程。

## 2. 已冻结决策

1. 唯一网络为 Ethereum Sepolia，`chainId = 11155111`。
2. 身份采用 MetaMask wallet-only，不引入 Privy、Google 登录、Smart Wallet 或 Paymaster。
3. 登录使用 challenge-sign-verify，成功后签发 HttpOnly Session。
4. 撮合完全链下执行。未被选中的 Agent 不发送交易，因此不存在“申请 gas”。
5. 已发送或 reverted 的 Sepolia 交易 gas 按以太坊规则自然消耗，Agent Market 不承诺返还。
6. YD 本金不是 gas，不得静默销毁。预算、6% 履约保证金和模拟收益只能通过明确的合约终态结算。
7. 保留四个不可升级合约：`YDToken`、`AgentMarketEscrow`、`ArbitrationCommittee`、`StakeYieldVault`。
8. `request_id` 贯通 HTTP、凭据审计、PostgreSQL、Outbox、SNS/SQS/DLQ、撮合、训练、交易意图、回执验证和 Evidence。
9. 链上只保存 `bytes32 requestRef = keccak256(request_id)`，不公开内部 UUID 原文。
10. API Key 使用 AES-256-GCM envelope。优先复用兼容的现有密钥或 Secret；创建付费 KMS CMK 前再次确认。
11. The Graph 不属于作业强制要求，不进入二期关键路径。交易回执通过 RPC 复核，公开 Evidence 通过 Blockscout 回读。
12. AWS 复用受保护的 VPC、NAT、RDS、OIDC 和 artifact foundation，不重复创建共享基础设施。

## 3. 总体架构

```text
浏览器 + MetaMask
  -> Cloudflare Edge SSR 与同源 API 代理
  -> API Gateway
  -> Next.js Transaction Lambda
  -> agent_market PostgreSQL Schema + Transactional Outbox
  -> SNS -> SQS / DLQ
  -> Go Matcher -> PostgreSQL + pgvector
  -> 一次性 ECS 梯度提升 CTR Trainer
  -> MetaMask 签名的 Sepolia 合约交易
  -> RPC 回执对账 + Blockscout Evidence 回读
  -> 中英双语 Evidence 页面
```

### 3.1 Cloudflare 边界

Cloudflare 负责：

- Edge SSR、hydration 和一次致命失败 CSR fallback
- 同源入口、安全响应头、Origin 和请求体限制
- `request_id` 入口传播
- Web Vitals 转发
- API 代理与超时保护

Cloudflare 不负责：

- 保存 Session 或 API Key
- 判断任务、付款或仲裁是否成功
- 持有钱包私钥
- 直接更新业务数据库

### 3.2 Transaction Engine 边界

Next.js Transaction Engine 负责：

- 钱包 challenge、签名验证、Session 和注销
- 角色、资源关系和状态机授权
- 幂等键和乐观锁
- 业务状态与 Outbox 同事务提交
- 生成待钱包签名的交易意图
- RPC 回执、事件和确认数对账
- 生成脱敏的 Evidence Projection

### 3.3 PostgreSQL 边界

PostgreSQL 保存：

- 钱包 challenge 和 Session Hash
- Agent、凭据密文和公开掩码
- Task、Submission、Dispute 和链下状态
- 幂等记录与消费事件去重
- 交易意图、交易哈希和对账状态
- pgvector、候选得分和推荐解释
- 训练样本、模型版本和恢复审计

链上资产状态仍以 Sepolia 为最终事实。

## 4. 钱包身份与 Session

### 4.1 Challenge

`POST /api/auth/challenge` 接收规范化钱包地址，返回：

- 单次 nonce
- domain、URI 和 statement
- Sepolia chain ID
- issuedAt 和 expiresAt
- requestId

钱包地址在入口统一转为 lowercase 后参与数据库唯一约束和幂等计算。

### 4.2 Verify

浏览器使用 MetaMask 签署规范消息，然后调用 `POST /api/auth/verify`。

服务端必须验证：

- 恢复出的 signer 与 challenge 钱包一致
- domain、URI 和 chain ID 正确
- challenge 尚未过期
- nonce 尚未消费
- `request_id` 与请求上下文一致

消费 challenge 与创建 Session 必须在同一数据库事务内完成。同一个 challenge 最多生成一个 Session。

### 4.3 Session

Cookie 规则：

```text
HttpOnly; Secure; SameSite=Lax; Path=/
```

- Session 有效期：30 分钟
- 敏感命令 recent-auth 窗口：5 分钟
- Logout 在服务端撤销 Session
- Session 只保存随机 ID 的 Hash，不保存可重放明文

## 5. Gas、托管与结算

### 5.1 Gas 决策

- 匹配、候选评分和选择均在链下完成。
- 未选中的 Agent 不发链上交易，因此不支付候选申请 gas。
- 被选中的 Agent 才调用 `acceptTask` 并存入预算 6% 的履约保证金。
- 每个链上调用者自行支付 Sepolia gas。
- Agent Market 不返还已消耗 gas，也不使用 YD 本金补贴 gas。

### 5.2 正常结算

1. 发布者创建链下草稿。
2. 钱包 approve YD。
3. 发布者调用 `createTask` 托管预算。
4. 链下撮合并选择 Agent。
5. Agent 调用 `acceptTask`，存入 6% 保证金。
6. Agent 提交成果。
7. 发布者调用 `acceptWork`。
8. 合约向 Agent 支付预算、保证金和已注资模拟收益。

### 5.3 超时与争议

- 超时或仲裁支持发布者时，合约按已定义规则处理本金和保证金。
- 3 个有效仲裁席位中达到 2 票即形成裁决。
- 任何终态只能结算一次。
- 收益池不足时记录 `yield_shortfall`，优先保护本金。

### 5.4 交易确认

浏览器返回交易哈希不代表成功。Transaction Engine 必须复核：

- chain ID
- 合约地址
- sender
- method selector
- requestRef
- 金额
- receipt status
- block number
- confirmations
- 事件名称与参数

RPC 超时进入 `verifying`，不能直接标记失败。链重组可使交易从 `confirmed` 回到 `reorged/verifying`。

## 6. Go 撮合与 pgvector

撮合顺序不可颠倒：

1. 硬过滤：active、分类、必要标签、Endpoint 健康、预算约束和最低质量阈值。
2. pgvector 语义召回。
3. 规则评分。
4. 已批准 CTR 模型调整排序。
5. 新人探索位。
6. 生成可解释结果。

规则评分权重：

| 指标 | 权重 |
| --- | ---: |
| 完成能力 | 30% |
| 质量反馈 | 25% |
| 沟通经验 | 15% |
| 低争议表现 | 15% |
| 历史完成规模 | 15% |

最终最多返回两个高分候选和一个满足最低门槛的新人。`request_id` 作为随机种子，保证同一请求可重放。

## 7. CTR 训练

现有 `LogisticRegression` 不满足梯度提升要求，二期改为 scikit-learn `HistGradientBoostingClassifier`。

模型产物至少包含：

- algorithm 和参数
- feature order
- sample count
- ROC-AUC
- log loss
- constant baseline log loss
- model hash
- training_run_id
- `candidate | approved | rejected`

只有同时满足以下条件才能标记 `approved`：

```text
ROC-AUC >= 0.60
model log loss < baseline log loss
```

模型激活仍是单独的人工动作。模型不得绕过硬过滤。

## 8. 幂等、DLQ 与恢复

### 8.1 幂等身份

```text
(actor_wallet, command, resource_id, idempotency_key)
```

- 钱包地址先转为 lowercase。
- 重复请求返回原结果。
- 业务状态与 Outbox 同事务提交。
- Consumer 使用 `(consumer, event_id)` 去重，因此多个 Consumer 可以分别消费同一广播事件。

### 8.2 DLQ Replay

- 原 event ID、request ID 和 idempotency key 必须保留。
- Replay 只能增加一条恢复审计，不得生成第二份业务结果。
- 毒消息经过有限重试后进入 DLQ。
- Ops 只允许人工批准的重放入口。

## 9. AWS 成本边界

实现和本地测试不要求 AWS 登录。部署前执行只读预算盘点。

允许复用或新增的工作负载：

- Next.js Lambda 包装路径
- Go Matcher Lambda 或短时执行路径
- 一次性 Trainer ECS Task Definition/Run
- 项目独立 SNS、SQS、DLQ
- 短日志保留期 Log Group
- 最小权限 IAM Role

禁止创建：

- 第二个 VPC、NAT 或 RDS
- ALB
- 常驻 ECS Service
- 未批准的 KMS CMK
- 自动生产部署和自动破坏性清理

## 10. Evidence 合同

Evidence 状态：

```text
planned
implemented
locally_verified
externally_verified
blocked
```

外部 Evidence 至少包含：

- 四个合约地址和部署交易
- 正常结算、争议、质押交易哈希
- RPC receipt 与事件投影
- Blockscout 公开链接
- request_id 全链路关联
- 数据库回读
- SQS/DLQ 重放结果
- ECS Task ARN、exit code 和训练指标
- 模型文件 Hash
- AWS pause 状态
- PR Checks、main Action 和 Worker Version
- 正式域名 HTTP/SSR 回读

截图只能作为辅助，不得单独证明运行成功。

## 11. 二期验收矩阵

| 项目 | 验收标准 |
| --- | --- |
| 1 | 四个合约部署到 Sepolia，并存在真实正常与争议交易 |
| 2 | 钱包 Session、权限、凭据和完整任务生命周期被真实运行 |
| 3 | 交易与事件 Evidence 可用 request_id 关联并独立回读 |
| 4 | Go 从 PostgreSQL/pgvector 获取候选并输出确定性解释 |
| 5 | 一次性 ECS 梯度提升训练生成指标和模型 Hash |
| 6 | 重复命令和 DLQ Replay 均只产生一个业务结果 |
| 7 | ADR 明确 The Graph 暂缓，不冒充已实现 |
| 8 | Ops 展示只读健康、恢复、交易、模型和成本状态 |
| 9 | GitHub Actions 不再产生 Node 20 JavaScript Action 弃用警告 |

## 12. 非目标

- 主网和真钱
- 真实收益承诺
- 跨链和 DAO
- 可升级代理合约
- 服务端持有用户私钥
- 自动仲裁、自动模型激活
- 自动合并或自动生产发布
- 未授权的付费资源
