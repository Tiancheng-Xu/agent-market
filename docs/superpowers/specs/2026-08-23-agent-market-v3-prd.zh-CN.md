# Agent Market V3 产品需求文档

> 2026-09-01 增补：L2 纳入 Risk Assessor、确定性风险定价、发布方与 Agent Team 对称保证金及 Reputation V2。详细设计见 `2026-09-01-agent-market-risk-pricing-reputation-v2-design.md`。真实收益 Vault、链上合约迁移和 DAO 仍属于长期 L3/L4，不能作为当前已实现或已验证能力展示。

状态：实现中。本轮冻结 L1 产品化与 L2 业务闭环；L3/L4 仅为长期计划。任何完成声明都必须绑定精确代码版本、Gate 与对应环境回读。

## 0. 设计与证据原则

- 以复杂度为唯一设计主题：优先深模块和最小接口，禁止为每个页面复制一套状态机或增加薄转发层。
- 从底层事实重推：数据库记录订单与业务总账，链上 Receipt/Event 记录链上事实，Evidence 记录验证事实，UI 只是可恢复投影。
- 所有设计结论必须可证伪：每条需求都声明正常路径、非法路径、失败原因和确定性验收 Gate。
- 小步重构且保持已发布行为：每个 Task 独立 Review，通过后才进入下一 Task；确定性 Gate 失败不能被 LLM Judge 覆盖。
- 资金状态不明时进入 `manual_review`；超时不等于失败，禁止直接重复发送交易或重复付款。

## 1. 产品目标

用户发布可验证任务，系统根据分类与标签召回 Agent，Queen 生成可修改
DAG，用户确认后锁定。Agent 自动接单并按节点执行，独立 Judge 与最终
Arbiter 验收。任务、工作流与资金状态使用链上哈希锚定，完整业务数据保留
在私有 AWS 边界。

## 2. 硬性流程

1. 发布者填写任务分类、标签、预算、时限和验收标准。
2. 发布者支付任务预算与固定 6% 平台发布费；发布费不返还。
3. 链上确认 `taskId` 与资金到账后，系统创建工作流。
4. Queen 生成 DAG；用户可修改节点、依赖和 Agent。
5. 用户确认后锚定 `workflowId + dagHash + version`，图与派单锁定。
6. 每个节点按硬过滤、评分和探索规则，从最多 4 个不同模型候选中选 3 个。
7. 入选 Agent 心跳在线时自动接单，不要求 Owner 手工确认。
8. 节点执行后由上下文隔离的独立 Judge 审查；失败进入 Red Team/Repair。
9. 最终 Arbiter 必须独立于 Queen 与执行 Agent。
10. 当前 V3 合约由平台管理员作为唯一链上最终裁决者。

## 3. 匹配与评分

- 先按权限、健康、任务 category、全部 required tags、能力、预算和 License
  做硬过滤，任何模型评分都不能绕过硬 Gate。
- 新 Agent 初始分 30。
- 历史质量分采用 90 天滑动窗口、最近最多 20 次、30 天半衰期的指数衰减。
- 候选按 `modelTag` 去重；最多 4 个候选进入抽卡池，最终选 3 个。
- 前两位按综合分；第三位优先保护合格新人探索。
- 低分旧模型进入淘汰状态；淘汰必须保留原因码与审计记录。

## 4. Agent 注册与市场准入

- 浏览器 IndexedDB 只保存钱包隔离的公开元数据，不保存密钥、端口、权重、
  原始 Prompt 或私有路径。
- 本地 Ollama Agent 始终 `owner-only`，只有签名 Owner Runtime 心跳后可选择。
- 免费 HTTPS Agent 可直接进入市场目录。
- 付费 HTTPS Agent 必须通过平台测试后才公开；未通过时保持隐藏。
- Agent 进入市场后通过心跳保持可用，入选任务后自动接单。

## 5. 资金与链上身份

- 发布费：任务预算的 6%，创建任务时转入平台 Treasury，不返还。
- Agent 节点质押：接单时锁入合约，并铸造唯一 ERC-721 质押回执。
- Agent 胜诉：按节点份额领取预算，并凭回执领取原质押；回执领取后销毁。
- 发布者胜诉：预算退还发布者，Agent 质押按裁决规则转入平台 Treasury。
- 用户自己的 Agent 参与时与其他 Agent 使用相同回执规则，任务通过后退回质押。
- 链上只保存标识、状态、金额和内容哈希；完整 DAG、节点输入输出保留在私有 AWS。

## 6. 数据出站边界

- 只允许当前任务节点的 `node-input` 或 `node-output` 通过 AWS 节点交换边界。
- 信封必须包含 requestId、runId、taskId、nodeId、agentId、方向和内容 SHA-256。
- HMAC、时间窗、nonce、防重放、大小限制与敏感内容扫描全部通过后才转发。
- 完整 DAG、训练数据、模型权重、API key、私有路径和原始日志禁止出站。

## 7. 虚拟办公室

- React 页面只展示进行中和已完成项目；一张任务对应一张桌子，已接单 Agent 显示在任务桌座位。
- Cocos Creator 3.8.8 负责桌子、Agent、状态与娱乐动画，已完成本地 Web Desktop 产物和真实运行时渲染 Gate。
- Cocos 只接收脱敏 `OfficeSnapshotV2`，只允许回传 `select-desk` 事件；不得接触钱包签名、私有节点输入输出、下载内容或工作流执行权限。
- Owner 的节点边界和结果下载继续由 React 与已验证 Owner 身份控制；访客只能查看公开状态、标签、角色和娱乐动画。
- Cocos 不可用或超时时，React 显示明确降级状态，不伪造办公室已加载或任务已成功。

## 8. 本轮 L1：现有能力产品化

### 8.1 Agent 生命周期

- Agent 版本状态统一为 `draft`、`reviewing`、`published`、`paused`、`retired`。
- 状态机必须集中实现，页面不能直接拼接状态；暂停、恢复和退役必须保留原因与操作者记录。
- 市场和任务只能选择满足可见性、准入、健康和版本状态 Gate 的 Agent。

### 8.2 可解释市场

- 搜索、分类、Tags、能力、Provider、License、权限和健康状态先执行硬过滤。
- 排序必须输出可复现分数与脱敏推荐原因；被拒绝项保留原因码。
- 详情页区分目录展示、可选择、可执行和可交易四种边界。

### 8.3 Queen DAG 工作室

- ReactFlow 先读取真实 Queen DAG；用户确认前可编辑节点、依赖和 Agent 分配。
- 确认后锚定版本并锁定；Repair 只能生成后续版本，不能覆盖历史。
- 每个节点显示 Role、Input/Output Contract、Artifact、Milestone、状态、失败原因和 Evidence。

### 8.4 钱包与 Cocos 投影

- 钱包时间线依次展示连接、认证签名、Intent、用户确认、广播、Receipt、事件匹配与业务投影。
- Cocos Office 仅消费同一工作流的脱敏 `OfficeSnapshotV2`，不成为订单、资金或执行状态源。

## 9. 本轮 L2：订单、信誉与争议闭环

### 9.1 单 Agent 订单

- 订单状态为 `draft -> quoted -> authorized -> running -> delivered -> accepted|disputed -> closed`。
- 订单冻结 Agent 版本、需求、预算、时限、验收标准、Artifact 与 Evidence 引用。
- 所有写操作使用稳定业务 ID 和幂等键；状态迁移必须验证当前状态与钱包权限。

### 9.2 Team 与交付 Gate

- Queen、Worker、Judge、Final Arbiter、Red Team 与 Repair 必须声明独立 Role、Context、Input/Output、Artifact、Milestone、权限、超时和失败路由。
- 评价资格只来自完成并验收的订单；Judge 评分不能替代编译、Schema、权限、Receipt/Event 等确定性 Gate。

### 9.3 信誉与反作弊

- 复用 90 天窗口、最近 20 次、30 天半衰期、新 Agent 初始分 30 与低样本平滑。
- 质量、准时率、验收率、退款率和争议率分开记录；异常关联评价进入降权或人工复核。

### 9.4 资金与争议

- Escrow、退款、质押、罚没、售后和仲裁必须通过 Intent、钱包交易、Receipt、事件匹配和业务投影形成可追溯链路。
- 资金位置不明、Provider 结果不确定或链上回读冲突时停止自动推进并进入 `manual_review`。

## 10. 长期计划

- L3：多 Agent 套餐、父子订单、多 Provider 收益策略、PayoutManifest、Claim 与统一账本。
- L4：运营告警、补偿扫描、DLQ、发布门禁、资金对账、双人复核、售后工单和完整审计。
- L3/L4 不属于本轮完成范围；没有订单账本、幂等执行和对账 Gate 前不得上线真实收益 Claim。

## 11. 当前状态边界

- `verified-local`：匹配评分、DAG 状态机、用户注册表、Cocos 虚拟办公室及其 React 权限边界、
  两个新 owner-trained 模型的 Agent Market Runtime smoke、V3 合约专项测试、AWS 节点交换契约。
- `verified-production`：V3 Sepolia 合约与既有 24 笔交易、事件及终态独立回读；Cloudflare Web 与链上证据保持分离。
- `pending-external`：当前网页版本的补充钱包录屏、V3 AWS 节点交换部署与全链回读。
