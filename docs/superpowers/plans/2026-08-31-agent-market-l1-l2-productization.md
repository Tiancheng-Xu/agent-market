# Agent Market L1/L2 产品化长期实施计划

## 目标与边界

本轮只交付 L1 产品化和 L2 业务闭环。L3/L4 进入长期路线图，不进入本轮完成率、Evidence 数量或生产能力声明。

事实来源固定为：

1. 数据库是订单、评价、版本和业务状态总账。
2. Sepolia Receipt 与匹配 Event 是链上事实。
3. Queen/LangGraph 保存工作流版本、分支、恢复与失败路由。
4. Cloudflare/React/Cocos 只做受权限约束的交互和投影。
5. Evidence 只记录经过 Gate 的事实，不参与业务决策。

## 设计约束

- 用深模块隐藏状态迁移、排序、幂等、链上回读和评分复杂度；页面只消费稳定用例接口。
- 不为 L1/L2 引入新的顶层 Agent 框架。现有 Queen GraphQL/LangGraph 足以承担状态分支；ReactFlow 只编辑/展示 DAG。
- 每个 Task 都必须有可证伪验收、非法路径、失败原因、Repair 责任节点和独立 Review。
- 资金相关操作先记账再派工；超时先查询，不直接重付；无法确认资金位置时 `manual_review`。
- 不重复创建 VPC、NAT、RDS、ECS Cluster 或 OIDC；不修改 AWS Free 计划；不为录屏重复发送已有 Sepolia 生命周期。

## 深模块边界

| 模块 | 最小公开接口 | 隐藏的复杂度 |
|---|---|---|
| Agent Lifecycle | createVersion, submit, publish, pause, resume, retire | 合法迁移、审计、版本冻结、市场准入 |
| Marketplace Query | search, explainCandidate | 硬过滤、排序、探索、原因码、可见性 |
| Workflow Studio | loadDraft, editDraft, confirmVersion, appendRepair | DAG 校验、版本锁、角色隔离、Repair 历史 |
| Transaction Lifecycle | prepare, submit, refresh, project | Intent、钱包状态、Receipt/Event、幂等和冲突 |
| Order Service | create, authorize, start, deliver, accept, dispute, close | 状态机、权限、Artifact、验收与幂等 |
| Reputation Service | recordEligibleReview, calculateSnapshot | 资格、窗口衰减、低样本平滑、异常降权 |
| Office Projection | projectSnapshot, selectDesk | 脱敏、Cocos 降级和只读状态映射 |

## 执行顺序

### T1 Agent 生命周期与版本

- 建立共享 Domain 状态机和 Schema。
- 迁移现有目录与本地注册表到统一读取模型。
- 更新创建、详情、审核、暂停、恢复和退役 UI。
- Gate：合法/非法迁移、Owner/Reviewer 权限、历史版本不可变。

### T2 可解释市场

- 建立统一 Query 与 CandidateExplanation。
- 接入现有 Tags、Provider、License、Owner Scope、健康和评分。
- 更新搜索、排序、推荐原因和不可用状态 UI。
- Gate：相同输入得到相同候选；硬 Gate 不可被评分绕过。

### T3 Queen DAG 工作室

- 先把现有 GraphQL DAG 映射为 ReactFlow 只读图。
- 加入启动前编辑、校验、确认和版本锁。
- 显示 Role、Agent、Artifact、Milestone、Gate 和失败路由。
- Gate：循环依赖、缺失角色、重复模型和越权修改被拒绝。

### T4 钱包交易时间线与 Office 投影

- 统一认证签名和交易签名视觉边界。
- 将 Intent、广播、Receipt、Event 和业务投影映射到单一时间线。
- 用同一 DAG 生成 `OfficeSnapshotV2`，Cocos 只读消费。
- Gate：刷新/重载可恢复；超时不产生假成功；Cocos 失败不影响业务状态。

### T5 单 Agent 订单与验收

- 建立订单、交付、Artifact、验收和评价资格 Domain。
- 实现稳定业务 ID、幂等键、钱包权限和审计。
- 更新任务发布、订单详情、交付、验收与争议 UI。
- Gate：重复提交、非参与钱包、空交付和非法状态迁移全部拒绝。

### T6 Agent Team 契约

- 为每个节点冻结 Role、Context、Input/Output、Artifact、Milestone、超时、预算、权限和失败路由。
- Judge 与 Final Arbiter 保持独立 Context；Repair 只追加版本。
- Gate：确定性失败不能被模型评价覆盖；失败只回到责任节点。

### T7 信誉与反作弊基础

- 只消费具备评价资格的已验收订单。
- 计算质量、准时率、验收率、退款率和争议率快照。
- 使用冻结数据集比较 baseline/candidate。
- Gate：低样本平滑、时间衰减、重复评价和异常关联行为覆盖。

### T8 Escrow、退款与仲裁产品化

- 把现有合约能力映射为订单动作和交易时间线。
- 保留平台唯一最终仲裁者边界。
- 任何不确定资金状态进入 `manual_review`。
- Gate：Receipt/Event 精确匹配、退款/罚没互斥、重复执行幂等。

## Feature QA

- 全仓 tests、typecheck、build、Schema、权限、secret/PII 扫描。
- Edge SSR、Hydration、真实 404、深链和资产语义。
- 375、390、430、1440 px BackstopJS，人工审查差异；无根级横向溢出和 pageerror。
- Queen 成功、Provider 失败、超时、取消、重试、Repair、Judge 与 Final Arbiter 完整矩阵。
- 钱包未连接、签名拒绝、交易拒绝、Receipt 失败、事件不匹配和恢复路径。
- 外部完成必须绑定 main SHA、Actions Run、Cloudflare deployment、URL 和脱敏 Evidence。

## 长期路线图

- L3：父子订单、多 Agent 套餐、Provider 分账、PayoutManifest、Claim 和统一账本。
- L4：运营告警、补偿扫描、DLQ、发布门禁、资金对账、双人复核、售后工单与审计。
- 进入 L3 的前置 Gate：L2 订单状态机、幂等、Receipt/Event 回读和 `manual_review` 已在生产 Evidence 中通过。
