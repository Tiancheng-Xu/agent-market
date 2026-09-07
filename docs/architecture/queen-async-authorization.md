# Queen 异步执行的身份与恢复边界

状态：本轮接入设计；尚未完成端到端实现。2026-09-04。

## 已确认的代码事实

- Transaction Engine 的 `auth/session.ts` 提供钱包会话；现有风险报价路由通过 `authenticateSession` 的返回值取得 actorWallet，而不是信任请求体中的钱包。
- Local Runtime 的 CallerAccess 仅包含 public/owner，现有 Queen GraphQL 转发没有任务所属钱包的校验。两个 schema 仅隔离访问级别，不构成租户身份授权。
- 异步事件的 scopeId、taskId 和 operationKey 是标识，不是凭证。SNS 来源策略只能限定投递者，不能证明业务调用者有权审批或执行任务。

## 本轮接入决定

1. 以 Transaction Engine 已认证钱包会话作为用户身份入口，复用现有来源/会话检查；不新增独立登录系统，不把 Cookie 发入队列。
2. 服务端读取当前任务所有权、参与角色、图版本及风险审批；建立最小私有执行授权记录，绑定任务、作用域、图指纹、操作、有效期、撤销状态及允许的资源引用。
3. 私有授权记录、业务状态与 Outbox 必须在同一数据库事务内提交。当前 Local Runtime 快照 Outbox 不可被误当作跨服务原子事务；需明确单一写入权威，不能在两个数据库分别提交后声称原子成功。
4. 队列只发送不透明授权/载荷引用及哈希。Worker 从可信服务或受限数据库角色解析引用；每次执行或恢复前重验授权有效性、任务状态、图版本与当前角色，不接受消息自带身份作为授权结果。
5. 用户会话和后台任务授权分开建模：后台等待不能要求长期复制登录 Cookie；会话过期与任务撤销不是同一事件。任务授权的期限和撤销规则需要显式实现，敏感审批仍要求当前认证与角色。
6. Checkpoint 只恢复进度，不能恢复过期权限。审批恢复必须关联权威授权记录；旧审批、变更后的图、撤销任务一律拒绝。结果未知的外部副作用先核对执行日志，不盲目重试。

## 必须通过的验收

- 另一钱包知道 taskId、scopeId 或 payloadRef 仍不能提交、审批或恢复该任务。
- 被撤销的任务授权、过期授权和旧图消息不会进入模型或资金副作用。
- 同一数据库事务回滚时，授权、任务状态和 Outbox 均不遗留半成品。
- 正常审批暂停经 PostgreSQL 重启恢复后，重新核验身份和图版本，不重复已完成操作。
- 保留明确的拒绝原因码，不公开 Cookie、私有提示词、连接字符串和原始授权记录。

## 当前状态与未完成边界

本地实现已经接通认证写入口、审批记录与 Outbox 同事务提交、Worker 当前授权解析、PostgreSQL Checkpoint、持久化 operation ledger，以及真实 Queen GraphQL/StateGraph 业务适配。规划阶段会在批准前确定并持久化 required node 的 Agent 分配；批准事件同时绑定 canonical `graphHash` 与 `assignmentHash`。执行阶段只验证并确认这份已批准分配，不会二次选人。系统运行时新增的 Repair/Red Team 节点必须带 `systemAppended` 标记，且不能改写已批准基础图或分配。

公开 Queen GraphQL mutation 默认拒绝，只有显式注入服务端 authorizer 才可启用。Transaction Engine 的规划与批准 API 还要求 `QUEEN_ASYNC_PLANNING_ENABLED=true` 和 `QUEEN_ASYNC_WORKER_READY=true` 同时成立；当前没有部署持续 Worker，因此生产环境应保持后者关闭，防止产生无人消费的队列。

真实 AWS SNS/SQS/DLQ、IAM、Worker 启动器、轮询/停机、毒消息 redrive、告警与成本回读仍未验收。现有 PostgreSQL 与 mock SDK 测试只证明本地契约，不能升级为 AWS 或生产 Evidence。
