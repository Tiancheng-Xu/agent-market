# Agent Market 二期实施计划

> 执行要求：使用 TC Flow 按 Task 执行；每个 Task 必须经过目标测试、脱敏 Diff、独立 Review 和 Checkpoint 后才能进入下一项。

**目标：**交付可验证的 Sepolia Agent Market，包括钱包 Session、链上对账、Go 撮合、梯度提升 CTR、DLQ 恢复、只读 Ops 和完整 Evidence。

**架构：**保留 V1 Cloudflare Edge SSR 与现有 Solidity、Next.js、Go、Python、PostgreSQL、AWS 模块。围绕钱包认证、交易意图与对账、pgvector 撮合、模型生命周期和恢复增加稳定适配器，不把业务真相移到前端或 Edge。

**技术栈：**React 19、Vite 7、Next.js 16、TypeScript、Solidity 0.8.28、Hardhat、ethers 6、Go、PostgreSQL/pgvector、Python 3.14、scikit-learn 1.8、AWS Lambda/SNS/SQS/DLQ/ECS、Cloudflare Workers、Blockscout。

**中文设计：**`docs/superpowers/specs/2026-08-21-agent-market-phase2-design.zh-CN.md`

**Contract Hash（v2）：**`1883dc4bac396a4cf030260908cbc333911ed70cee205f390e92dce45687558c`

## 全局约束

- Sepolia chain ID 固定为 `11155111`。
- gas 永不补偿；未选中 Agent 不提交交易。
- 6% Agent 保证金不可退还、不参与收益计算，任何结算都进入部署时指定的平台 Treasury。
- YD 本金和 6% 保证金只通过明确合约状态结算。
- The Graph、Privy、Paymaster、主网和 KMS CMK 创建不在当前 Contract 内。
- 生产发布、AWS 写操作、Sepolia 交易提交和破坏性清理需要动作前授权。
- 并发上限为 2；并发 Worker 不得写同一文件。
- 每个 Task 最多进行 3 轮独立 Review repair。

---

## T1：共享类型与 PostgreSQL 生命周期

**状态：已完成，独立 Reviewer 通过。**

### 文件

- 新增 `database/migrations/0003_phase2_lifecycle.sql`
- 新增 `packages/shared-contracts/src/auth.ts`
- 新增 `packages/shared-contracts/src/transactions.ts`
- 修改 `packages/shared-contracts/src/events.ts`
- 修改 `packages/shared-contracts/src/index.ts`
- 修改 `packages/shared-contracts/src/contracts.test.ts`
- 修改 `apps/transaction-engine/src/persistence/schema.test.ts`
- 新增 `apps/transaction-engine/src/persistence/schema.integration.test.ts`

### 产出接口

- `WalletChallengeV1Schema`
- `WalletSessionV1Schema`
- `TransactionIntentV1Schema`
- `TransactionVerificationV1Schema`
- `DlqReplayRequestedV1Schema`
- challenges、sessions、idempotency、chain transactions、match candidates、feedback、model versions、replay audits 表

### 已验证结果

- shared contracts：`4/4`
- transaction-engine：`23/23`
- PostgreSQL/WASM：真实执行 `0001 -> 0002 -> 0003 -> 0003`
- 独立 Review：第 3 轮 `pass`

---

## T2：合约部署、requestRef 与 gas 规则

### 文件

- 新增 `packages/contracts/scripts/deploy-sepolia.ts`
- 新增 `packages/contracts/src/deployment-manifest.ts`
- 新增 `packages/contracts/test/DeploymentManifest.test.ts`
- 修改 `packages/contracts/hardhat.config.ts`
- 修改 `packages/contracts/contracts/AgentMarketEscrow.sol`
- 修改 `packages/contracts/test/SettlementFlow.test.ts`

### 接口

- 部署清单包含 chain ID、四个地址、部署交易哈希、部署者地址和 block number。
- 清单不得包含私钥、RPC URL、Token 或环境变量值。
- Escrow 关键事件携带 `bytes32 requestRef`。

### 执行步骤

- [ ] 增加 requestRef 传播、唯一结算和部署清单失败测试。
- [ ] 运行 `pnpm --filter @agent-market/contracts test`，确认新行为在实现前失败。
- [ ] 修改合约事件与方法参数，保持已有本金和收益规则。
- [ ] 实现环境变量驱动的 Sepolia 部署脚本。
- [ ] 运行合约测试、compile 和部署清单校验。
- [ ] 本 Task 不提交真实 Sepolia 交易。

### 验收

- 本地部署顺序确定且地址依赖正确。
- 未选中 Agent 不调用合约。
- gas 文案与合约资金规则分离。
- 相同 Task 不能重复结算。

---

## T3：钱包 Challenge 与 HttpOnly Session

### 文件

- 新增 `apps/transaction-engine/src/auth/challenge.ts`
- 新增 `apps/transaction-engine/src/auth/session.ts`
- 新增 `apps/transaction-engine/src/auth/auth-store.ts`
- 新增 challenge/session 测试
- 新增 `/api/auth/challenge`
- 新增 `/api/auth/verify`
- 新增 `/api/auth/logout`
- 修改 `apps/transaction-engine/package.json`

### 接口

```ts
issueChallenge(address, requestContext): Promise<WalletChallengeV1>
verifyChallenge(message, signature): Promise<WalletSessionV1>
revokeSession(sessionId): Promise<void>
requireRecentAuth(session, now): void
```

### 执行步骤

- [ ] 增加成功、过期、nonce replay、domain、chain、wallet mismatch 测试。
- [ ] 增加 Cookie flags、logout 和 recent-auth 测试。
- [ ] 使用 ethers 恢复签名地址。
- [ ] challenge 消费与 Session 创建放在同一事务。
- [ ] Cookie 使用 `HttpOnly; Secure; SameSite=Lax; Path=/`。
- [ ] 运行 auth tests、typecheck 和 Next build。

### 验收

- 同一 challenge 只能成功一次。
- 地址大小写统一命中同一身份。
- Session 原始值不进入数据库、日志或响应正文。

---

## T4：交易意图、回执对账与 Evidence

### 文件

- 新增 `apps/transaction-engine/src/chain/intents.ts`
- 新增 `apps/transaction-engine/src/chain/reconcile.ts`
- 新增 `apps/transaction-engine/src/chain/evidence.ts`
- 新增 `apps/transaction-engine/src/chain/reconcile.test.ts`
- 新增 `/api/transactions/intents`
- 新增 `/api/transactions/verify`
- 新增 `scripts/blockchain/readback-agent-market.mjs`
- 修改 Task 状态机与测试

### 接口

- 服务端只产生 unsigned transaction intent。
- MetaMask 是唯一签名者。
- 对账结果为 `verifying | confirmed | failed | reorged`。
- Evidence Projection 只保留公开地址、交易、事件和 requestRef。

### 执行步骤

- [ ] 增加 wrong chain、to、sender、selector、requestRef、amount 测试。
- [ ] 增加 failed receipt、确认数不足、重复确认和 reorg 测试。
- [ ] 实现 Intent Builder 和注入式 Chain Reader。
- [ ] 扩展 Task 状态：`funding_pending`、`funded`、`disputed`、`settled`、`refunded`。
- [ ] Blockscout unlock 后探测响应 Schema，再写有界回读脚本。
- [ ] 未获授权前不发送真实交易。

### 验收

- `confirmed` 必须有 block number、正确认数和匹配事件。
- RPC 超时只能进入 `verifying`。
- Hash 和地址统一 lowercase 持久化。

---

## T5：Go pgvector 撮合与新人探索

### 文件

- 新增 `services/matcher-go/internal/store/postgres.go`
- 新增 store 测试
- 新增 `services/matcher-go/internal/handler/sqs.go`
- 新增 SQS handler 测试
- 修改 ranking、main 和 `go.mod`

### 接口

- PostgreSQL Repository 先做硬过滤和 pgvector recall。
- Ranking 最多返回两个 Top + 一个合格新人。
- 同一 request ID 的同分顺序固定。
- SQS Consumer 使用 `(consumer, event_id)` 去重。

### 执行步骤

- [ ] 增加硬过滤、SQL、确定性、重复事件和毒消息测试。
- [ ] 运行 `go test ./...`，确认新测试先失败。
- [ ] 实现 PostgreSQL Repository 和 SQS Handler。
- [ ] 实现 30/25/15/15/15 权重评分。
- [ ] 输出分项得分、解释、模型版本和 exploration 标记。
- [ ] 运行 `go vet ./...` 与 `go test ./...`。

### 验收

- 不合格候选永远不会被 CTR 模型重新带回结果。
- 不足三人时返回实际合格数量，不用假数据补齐。

---

## T6：梯度提升 CTR 模型生命周期

### 文件

- 修改 trainer contracts、train 和测试
- 新增 `model_store.py`
- 新增 `test_model_store.py`

### 接口

```python
train_model(input_path, output_path, training_run_id) -> ModelArtifact
```

产物包含 ROC-AUC、log loss、baseline log loss、model hash 和生命周期状态。

### 执行步骤

- [ ] 把当前 LogisticRegression 断言改为梯度提升失败测试。
- [ ] 增加门槛、拒绝、确定性 Hash 和无 PII 测试。
- [ ] 使用 `HistGradientBoostingClassifier`。
- [ ] 不满足指标时标记 `rejected`，不能自动激活。
- [ ] 运行 `.venv/bin/pytest -q`。
- [ ] 本地构建 Trainer Image，但不推送 ECR。

### 验收

- ROC-AUC 至少 0.60 且 log loss 优于 baseline 才能 approved。
- 模型文件不包含 request_id、sample_id 或钱包地址。

---

## T7：DLQ Replay、只读 Ops 与 AWS 边界

### 文件

- 新增 recovery replay 与测试
- 新增 ops health 与测试
- 新增 `/api/ops/health`
- 修改 `infra/aws/template.yaml` 与测试
- 修改 AWS pause 脚本

### 接口

- Replay 保留原 event ID、request ID 和 idempotency key。
- Ops 只返回脱敏健康状态，不提供 mutation 命令。
- IaC 只创建项目工作负载并支持可逆暂停。

### 执行步骤

- [ ] 增加 replay 单结果、只读 Ops、IAM 和成本边界测试。
- [ ] 增加不得创建 VPC、NAT、RDS、ALB、常驻 ECS Service 的断言。
- [ ] 实现 Recovery 和 Ops。
- [ ] 扩展 workload-only IaC，不部署。
- [ ] AWS 登录恢复后只生成 Change Set Preview。

### 验收

- Replay 不产生第二份业务结果。
- Ops 不能转账、投票、部署或修改 AWS。
- ECS 并发和日志保留期有界。

---

## T8：Evidence、Actions 与交付门禁

### 文件

- 修改 `README.md`
- 修改 `docs/evidence/requirements.yaml`
- 修改 Evidence 页面和全链路组件
- 修改 GitHub Actions workflows
- 新增 `docs/architecture/adr/0001-defer-the-graph.md`
- 新增二期本地验证 Evidence JSON

### 执行步骤

- [ ] 增加 Evidence validator 失败测试。
- [ ] 更新 README，区分 V1 已验证和 V2 状态。
- [ ] Evidence 只展示当前真实状态。
- [ ] 升级 GitHub JavaScript Actions，消除 Node 20 warning。
- [ ] 写 The Graph deferred ADR。
- [ ] 运行完整 `pnpm verify`、Go、Python、SSR route matrix 和秘密扫描。
- [ ] 执行独立 Feature QA、Repository Policy 和 Stop Hook。
- [ ] 全部通过后 Commit、Push 和创建 PR。

### 外部门禁

以下动作仍需动作前授权：

- Sepolia 部署和业务交易
- AWS Stack 更新和 ECS RunTask
- ECR Push
- PR Merge
- Cloudflare Production Deploy
- AWS 服务暂停或清理

## 最终交付条件

只有同时满足以下条件才能称二期完成：

- 8 个 Task 均经过独立 Review
- Feature QA `pass`
- Repository Policy `ALLOW`
- 本地完整验证通过
- PR 远端检查通过
- Sepolia、AWS 和 Cloudflare 外部回读存在
- Evidence 与实现状态一致
- AWS 项目工作负载完成验证后已暂停
