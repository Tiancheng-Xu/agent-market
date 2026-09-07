# Agent Market Todo List

## 2026-09-07 非 AWS 收口检查点

- [x] 钱包审批已通过 Transaction Engine 的 HttpOnly 会话进入，原子绑定 `taskId + taskVersion + graphRevision + taskFingerprint + graphHash + assignmentHash + decision`，并与审批 Outbox 事件同事务提交；跨钱包、旧版本、旧指纹、图/分配漂移、冲突重复审批及 Outbox 提交失败均 fail closed。
- [x] 同一 Worker 已串联 planning 与 approval 两类事件；批准后从 PostgreSQL Checkpoint 恢复，不重复 Queen planning。真实 Queen GraphQL/StateGraph 角色适配已覆盖 `Agent -> Judge -> Repair -> Judge -> Red Team -> Final Arbiter`，角色按独立 Agent/模型身份约束。
- [x] 恢复授权只接受未启动快照，或批准版本已经确认且具有合法 UUID `runId` 的快照；半启动、版本漂移、指纹漂移、过期批准和非法 run identity 拒绝。
- [x] 本地一次性 pgvector PostgreSQL 集成 Gate 通过：批准前 required node 分配已持久化并纳入哈希，审批拒绝不执行、批准恢复完成、重复消息不重复业务端口、Repair 后重新 Judge、高风险 Red Team/Final Arbiter 均执行一次；ledger 最终为 committed 后才删除消息，临时容器已清理。
- [x] 安全收紧后的全仓 `pnpm verify` 已通过：仓库与 Evidence 策略、TypeScript 测试/类型检查/生产构建、Solidity 本地 Hardhat、Go matcher、Python trainer 33/33。独立 reviewer 复核为 `No release blocker`。本轮没有发送 Sepolia 交易。
- [ ] AWS 云端库存、IAM/SNS/SQS/DLQ 真实配置、消费与 redrive 回读按用户要求暂时跳过；本地 SDK 拦截测试不能替代 AWS Evidence。

## 2026-09-04 长任务恢复检查点

### 本轮新增：SNS + SQS + DLQ 异步执行链（用户确认）

#### 当前实施顺序与完整链路

```text
认证钱包 -> Transaction Engine 授权/任务版本检查
         -> 同一数据库事务保存业务状态 + Outbox
         -> SNS 分发 -> SQS 缓冲 -> Worker 授权/幂等检查
         -> StateGraph -> PostgreSQL Checkpoint / 业务结果
         -> 持久化确认后删除 SQS 消息

等待审批 -> 保存 Checkpoint -> 结束本次消费
审批完成 -> 新 Outbox 事件 -> 同一链路恢复并重新检查授权
消费失败 -> 有界重投 -> 消费 DLQ -> 核对/修复 -> 受控重放
SNS 投递失败 -> 单独投递失败处理，不与消费 DLQ 混为一谈
```

1. [x] Transaction Engine 的钱包级授权、任务所有权与图版本检查，以及权威审批状态和 Outbox 原子提交已完成；消息中的 scopeId 不充当权限凭据。
2. [x] Worker 的授权/执行端口已接到真实 Queen GraphQL 与 StateGraph，持久化审批从同一 Checkpoint 恢复；外部副作用结果不明仍进入核对状态，不自动重复执行。
3. [x] 本地消费者入口、来源策略 Gate、可见性续租与显式暂停边界已实现。SNS 负责分发，SQS 负责缓冲/重投，DLQ 负责隔离，均不负责裁决或退款；真实云配置仍待 AWS 只读库存与回读。
4. [x] 隔离本地环境已覆盖重复、崩溃恢复、过期/非法授权、拒绝审批与受控 replay 契约；真实 AWS 毒消息、redrive 和停用状态仍单独待验。

以下条目为按阶段保留的历史记录；其中“尚未实现”的描述只代表记录当时。当前仍未验收的是持续 Worker 生产启动、真实 AWS 全链路、最终录屏与生产发布，不能按组件测试数量宣称外部闭环完成。Temporal 与 Chainlink VRF 保持后续计划。

- 授权接线已完成：Local Runtime 的 public/owner scope 不承担钱包级任务授权；Transaction Engine 以现有认证钱包会话为身份入口，原子保存审批记录与权威 Outbox，Worker 每个节点重新核对当前任务/图/指纹。详见 `docs/architecture/queen-async-authorization.md`。这仍是本地验收，不标记为已验证生产多租户服务。

- Worker 组合层已接线：`queen-async-worker.ts` 连接 Outbox/SNS、SQS 来源策略检查、当前授权、PostgreSQL 执行日志和真实 Queen GraphQL/StateGraph 业务适配；仍只提供显式单批发布/单条消费，不自动开启轮询。生产 API 使用 planning/worker-ready 双开关，未部署消费者时拒绝入队。真实本地 PostgreSQL + 拦截 SDK 的集成测试确认重复消息不重复业务执行、持久化完成后才删除；AWS 运行未执行。

- 队列策略核验已实现：GetQueueAttributes 只读适配 + 纯策略 Gate，核对精确队列 ARN、限定 SNS SourceArn 的最小发送授权、目标 DLQ 与 maxReceiveCount；拒绝宽泛 Allow。类型检查及 6 项本地策略测试通过，尚未调用 AWS。此 Gate 不证明账号身份策略、SNS 订阅配置或 DLQ 保留/重放权限安全，这些仍需云端库存与 IAM 审计。

- AWS SDK 适配已实现：精确依赖 SNS/SQS SDK 3.1126.0，SNS 发布回执、FIFO 分组/去重字段、固定 SQS 目标校验、SNS envelope Topic 校验、消费续租、持久化后删除；消费前强制外部队列策略核验端口。SDK 调用均被测试拦截，未访问 AWS。已修正测试的 SDK 重载类型和 JSON 字段顺序断言；Runner 类型检查通过，完整测试 95 passed / 2 skipped（本轮未提供临时数据库变量；两个数据库用例此前已分别实测）。仍缺真实策略核验、Worker 入口与端到端 AWS/DLQ 回读。

- Outbox 发布循环已实现：有限批量、FOR UPDATE SKIP LOCKED 领取、发布回执校验后标记 published；失败回滚为 pending。真实本地 PostgreSQL + 替身发布端口测试通过，覆盖失败保留、成功标记及后续不再领取，类型检查通过。真实 SNS SDK/消息来源配置尚未接入；发布成功但数据库提交失败仍可能重复投递，不能声明恰好一次投递。临时测试容器已清理。

- 事务 Outbox 存储与业务调用方已接通：planning request 和 approval 均生成严格事件，审批记录与 Outbox 同事务提交；版本冲突或 Outbox 失败会整体回滚。发布器/消费者通过 SDK 适配与本地拦截测试串联；尚未在 AWS 上线。

- 持久化执行日志已接入 Worker 并通过本地 PostgreSQL 综合集成测试：并发相同操作返回 busy，已提交返回 duplicate-committed 且不再调用副作用，结果未知持久化 uncertain 且重试不再执行。进程崩溃遗留 executing 超过 5 分钟后只会原子转为 uncertain，必须先核对再恢复，不会借超时自动重放外部副作用，因此不声称恰好一次。

- 消费契约、真实 Outbox、持久化执行日志和 SNS/SQS SDK 适配均已在本地串联：严格 schema、大小/时间边界、来源、当前授权、operationKey 与 payloadHash 先于执行；仅 committed 或 duplicate-committed 后删除，busy/uncertain 不确认。真实 AWS DLQ/redrive 仍未验收。

- [x] 本地串联事务 Outbox -> SNS 事件 -> SQS 消息 -> Worker -> StateGraph / PostgreSQL Checkpoint；审批等待先持久化并结束消费，审批通过后以新事件恢复，不长期占用消息可见性窗口。
- [x] 按 eventId、taskId、scope、graphRevision、operationKey 和 payloadHash 定义消息契约；消息仅携带最小元数据和受控引用，不承载密钥、原始私有 Prompt 或大体积产物。
- [x] Worker 消费前验证权限、图版本、来源与幂等执行日志；业务结果与恢复状态可靠保存后才删除消息。重复消息不重复业务端口，过期审批和旧图消息拒绝。
- [x] 重试责任已在本地契约中分离：SQS 负责消费重投，StateGraph 负责业务分支，不叠加无界重试；结果未知的外部副作用先核对，不盲目重试。真实 AWS 并发/告警配置待回读。
- [x] SNS 投递失败与 SQS 消费失败、DLQ 受控 replay 契约已分离；DLQ 不是自动成功或资金退款指令。真实 AWS redrive 待验。
- [ ] AWS 只读库存和复用矩阵先行：仓库 `infra/aws/template.yaml` 已声明 SNS/SQS/DLQ 相关资源，但不证明当前云端存在或适合业务任务。不得将性能采样消息与任务执行混用；核实队列类型、权限、保留期、费用、暂停/清理责任后确定精确 reuse/create 集合，保护共享基础和 Free-plan。
- [ ] 验收覆盖重复投递、延迟/乱序、Worker 崩溃、审批恢复、毒消息入 DLQ、修复后 redrive、无重复副作用和停用后队列/消费者状态；单独记录真实 AWS 证据，不以本地 Mock 替代。
- 当前状态：非 AWS 业务组合与本地持久化 Gate 已接通；持续 Worker、真实队列策略/redrive 和云端回读暂缓，未创建资源或触发 AWS。Temporal 仍为后续评估。

### 后续 TODO：Chainlink VRF（用户新增，待方案评估）

- [ ] 评估可验证随机函数用于合格新 Agent 的探索曝光、同分候选抽签；资格硬过滤、质量 Gate、风险评分和独立仲裁仍保持原有确定性规则，不随机决定资金归属。
- [ ] 设计抽签承诺：请求随机数前冻结候选集合、排序、权重、算法版本与任务指纹；明确重复请求、取消、超时、回调顺序、链重组和失败状态，禁止通过重抽选择有利结果。
- [ ] 明确公平边界：随机数可验证不等于候选池或权重公平，候选准入与权重必须可审计；评估女巫攻击与候选操纵风险。
- [ ] 核实目标测试网支持、合约兼容性、费用与资金需求；设计本地/测试网验收及脱敏 Evidence。未取得外部证据前不宣称 VRF 已上线，不用 Mock 作为链上随机性证明。
- 范围：本次仅加入 TODO，不安装依赖、不创建订阅、不充值、不部署或发送交易；实际实施前确定产品方案与执行预算。

### 本轮新增：StateGraph 与持久化 Checkpoint（用户最新确认）

- PostgreSQL scope 集成实测通过（1 项综合测试）：显式执行本地建表脚本，公开与 Owner 使用独立最小权限 LOGIN 角色；通过真实 Queen 编排器分别保存同一 taskId 的不同需求、互不串读；旧 recordVersion 更新拒绝；公开角色读取 Owner 表得到 PostgreSQL 42501。测试容器已退出清理。覆盖业务快照 SQL 路径与角色权限，不代表浏览器用户级授权或线上数据库配置已验收。

- Runtime 业务快照已接入可选持久化配置：`QUEEN_PUBLIC_DATABASE_URL` 与 `QUEEN_OWNER_DATABASE_URL` 必须同时配置；固定独立 schema，启动只读检查表，失败拒绝启动；不自动迁移，退出关闭连接池。显式建表脚本 `database/queen-runtime-scopes.sql` 已编写但未执行，数据库角色/租户隔离仍需实际配置和验证。Runner 类型检查及 82 项测试通过；这些测试未证明新增 PostgreSQL SQL 路径实测成功。此处是业务快照接线，任务级 LangGraph Checkpointer 仍需独立接入并解决一致性。

- PostgreSQL 进程恢复实测通过：`queen-checkpoint-restart-probe.ts` 在隔离本地 PostgreSQL 16 中用官方 PostgresSaver 保存审批 interrupt，确认落库后 SIGKILL 旧进程，新进程恢复同一线程、重新执行审批授权端口、完成 execute/judge/finalize，未重复 plan。临时容器通过退出清理停止。业务与授权端口均为替身，因此只证明真实磁盘/跨进程 Checkpoint 恢复，不证明生产身份验证、模型副作用去重或 GraphQL 已完成接入。

- 任务级图模块已实现：`queen-task-graph.ts` 支持 queen -> 审批 interrupt -> agent -> judge -> 限次 repair / final_arbiter，失败终止；每节点调用授权端口，审批绑定图版本与任务指纹，线程 ID 绑定 scope/task/revision/fingerprint。类型检查及 4 项 MemorySaver/替身端口控制流测试通过。尚未接入 GraphQL 服务入口，授权端口与业务去重必须由实际适配器实现；MemorySaver 不是持久化验收。待完成 PostgreSQL 保存、杀进程恢复、当前权限重验、Red Team 高风险路径与副作用执行日志。

- 持久化依赖准备：Runner 已安装精确版本 `@langchain/langgraph-checkpoint-postgres@1.0.5`，更新包清单与锁文件。官方 PostgresSaver 支持独立 schema；setup 会建表/迁移，本轮尚未调用、未连接数据库、未创建云资源。下一步必须把任务状态和恢复输入纳入图状态，并解决业务快照与 Checkpoint 的提交一致性，不能仅记录 stages 标签作为可恢复执行。
- 安装后 peer 检查风险：`@nomicfoundation/hardhat-ethers@3.1.3` 要求 Hardhat `^2.28.0`，当前安装 `2.26.3`。尚未修复；不凭依赖安装成功宣称链上构建兼容。不得为验证此项重复链上交易。

- 恢复前置修复：Repair/Red Team 按操作类型、父节点和 attempt 保存结果，快照持久化后可恢复复用；相同操作键更换 Agent 拒绝。旧快照没有 operationResults 时兼容为空。Runner 类型检查及现有 78 项测试通过；尚未新增该场景的断进程专项验收。模型完成但快照尚未落库的窗口、并发调用与旧图版本绑定仍待执行日志/恢复协议解决，不声明恰好执行一次。

- StateGraph 接入第一步：默认 Queen Runtime 现通过条件分支把业务操作派发至 queen/agent/judge/red_team/repair/final_arbiter/learning 节点，节点调用既有 GraphQL 业务处理函数；审批异常向外传播，不自动重试。Runner 类型检查及 78 项测试通过，其中 8 项新增分支/失败传播测试。仍是每次操作一个执行节点，尚未实现完整任务级恢复图和持久化 Checkpointer，不能声明本需求完成。

- [x] 深化现有 StateGraph：Queen、Agent、Judge、Repair、Final Arbiter 与高风险 Red Team 已进入真实 Queen GraphQL 业务节点和条件分支；Repair 后清除旧判断并重新 Judge，审批暂停与失败路由纳入契约。
- [x] 接入 PostgreSQL 持久化 Checkpoint：公开/Owner 业务快照 schema 隔离，任务线程绑定 scope/task/revision/fingerprint，状态版本冲突 fail closed。生产数据库配置与过期清理由部署阶段单独验收。
- [x] 本地恢复验收：进程终止后从持久化审批断点恢复、不重复 planning；当前授权、旧版本/指纹、拒绝审批、重复消息和角色独立性均有确定性 Gate。私有 Checkpoint 不作为公开生产或链上 Evidence。
- [ ] Temporal 后续评估：仅在跨服务长任务、交付截止时间、仲裁等待或可靠补偿确有需求时引入；先明确其与现有顶层编排及 LangGraph 的职责、重试所有权和订单状态权威，评估运维与成本，不直接部署。
- 范围说明：用户最新确认 StateGraph 与持久化 Checkpoint 纳入本轮交付；Temporal 仍为后续评估。尚未完成，不得将已有工作流快照等同于 LangGraph Checkpointer。
- 接入进度：已确认 Runtime 原先未向公开/Owner 编排器注入存储。本轮增加两套独立存储的注入入口并拒绝相同实例；尚未配置服务端持久化连接。不同实例仍可能连接同一表，必须补数据库命名空间及授权隔离后才能启用，实例检查不是租户安全证明。
- 必须补齐：真实执行节点进入 StateGraph、持久化 Checkpointer 与业务快照一致性、并发恢复/副作用去重、审批暂停恢复、断进程重启测试；禁止通过重跑整个任务来伪造断点恢复成功。

### 下一轮优先项：账户隔离与当前版本验收

- 受控浏览器补验通过：真实 OrderDetailRoute Provider + 替身延迟订单查询，依次 A -> B -> guest -> A，4 次独立请求；旧 A 请求收到 abort，随后旧响应返回没有跨账户渲染；mismatches=0、页面异常=0。证据：`docs/delivery/2026-09-04-order-session-browser-gate.json`。只覆盖前端会话缓存生命周期，不证明真实钱包认证、Cookie 轮换或生产行为。测试进程和隔离 Chrome 已退出。

- 当前本地验证：内部会话组件的可选钱包参数已归一为 null；22 项相关测试、完整 Web 161 项测试、类型检查、客户端/Edge SSR 生产构建全部通过。构建自带 6 项 Runtime Gate 通过，包含已知路由 200 与未知路由 404。主包仍为 531.37 kB（gzip 171.01 kB），保留体积告警；没有执行生产发布或将测试替身升级为真实钱包验收。

- 本轮代码修复：`OrderDetailRoute` 改为按钱包挂载独立 QueryClient Provider，卸载时取消查询并清理缓存；不再从浏览器全局单例取得缓存。增加独立挂载的账户隔离回归用例。尚未证明真实浏览器账户切换、认证 Cookie 变更及延迟响应场景，不将此项标记验收完成。

- [x] 订单查询缓存按认证会话隔离：按钱包挂载独立 QueryClient，卸载时取消并清理；受控浏览器 A -> B -> guest -> A 延迟响应 Gate 通过，不跨账户渲染。
- [x] 风险报价第六轮后的类型检查与受控会话交互验收已完成；仍不把替身会话升级为生产钱包证据。
- [ ] 最终录屏、独立审查、PR/CI 和 Cloudflare 生产发布仍待完成；本轮未执行 AWS、Sepolia 或生产写操作。

### 第五轮：真实订单风险报价前端接入

- 第六轮补充：增加只读刷新确认状态，复用同一权威回读函数；无需重复提交确认即可检查 Agent Team 是否完成确认。刷新前清除已有 funding context，指纹变化或过期时报错，manual_review 保持不可注资。报价编排 11 用例通过；仍需真实会话浏览器验收。

- 新增 LiveRiskQuotePanel 与 riskQuoteFlow，真实订单可读取服务端任务上下文、请求报价、确认报价并重新回读状态。只有 final + confirmed 且指纹一致、未过期时向订单页提供 funding context；服务端继续执行注资最终校验。
- 切换订单或钱包时重挂载订单页，清除上一上下文的确认状态。
- 新增 8 个编排测试覆盖服务端上下文不可用、指纹不一致、过期、初步报价、确认后的任务变化和最终确认条件。Web 31 文件、157 用例及类型检查通过。
- 验证边界：编排测试使用 API 替身；尚需真实认证会话与可用 RiskAssessorClient 的端到端验收。页面目前显示服务端报价摘要，八项因子完整展示与报价状态刷新仍需继续完善。此前 180 组合结果不覆盖本轮新接入。

### 第四轮：真实订单显示边界

- 真实 UUID 订单未加载或读取失败时，原页面会用第一条演示任务补标题、预算和状态。已改为专门的加载/不可用页面，失败时允许手动重试；禁止输出演示预算与生命周期。订单页 10 用例及 Web 生产构建通过。
- 发现尚未完成的 L2 集成：`RiskPricingContent` 对真实订单仍固定展示 unavailable，尚未接通已有 risk-context、报价和确认客户端。此项必须完成服务端权威上下文到报价、确认及 funding gate 的集成验收，才能标记风险报价产品能力完成。
- 第三轮 180 组合浏览器回归全部通过，HTTP、溢出、图片、按钮、页面异常、Cocos、中英文及混合语言失败数均为 0。结果见 `docs/delivery/2026-09-04-local-browser-gate.json`；仍仅证明受控本地路由 Gate。

### 第三轮：浏览器矩阵与本地化修复

- 最后一份 chain transaction store 集成测试补齐 0008/0009 migration 后通过，覆盖确认状态保护、并发、交易冲突及 reorg。至此先前跳过的 6 个数据库用例已按各自独立测试数据库完成补验；没有发送 Sepolia 交易。
- 首轮受控本地 Chrome 矩阵检查 18 路由、5 宽度、中英文共 180 组合。HTTP 语义全部符合预期，零横向溢出、零破图、零空按钮、零页面异常；Cocos 五个宽度均就绪，单次观察约 610–614 ms。
- 首轮未通过原因：Live、订单、匹配、争议页存在中文翻译遗漏。已补静态及分段文案、动态可靠性说明；Web 147 测试与生产构建通过，浏览器第二轮正在回归，尚未宣称视觉 Gate 完成。
- 当前浏览器回归使用本地 workerd 支持的 2026-07-29 compatibility date；生产配置为 2026-08-20，生产语义仍需发布后另行回读。
- 第一轮截图已查看移动 Live 和桌面 Office；截图检查不等于完整人工视觉基线批准，也不等于最终功能录屏。
- 第二轮 180 组合完成：仍无溢出、页面异常或 Cocos 就绪失败，混合语言问题已消除；剩余 7 条英文提示定位到子组件边界。订单 Risk/Reputation 子组件已改为读取当前语言，ReactFlow 内部说明已接入 Localized。最新组件修复仍需构建后浏览器回归。

### 第二轮：生产构建与真实 PostgreSQL 补验

- Web client/Edge SSR 构建通过，构建后运行时 6 个场景通过；交易引擎 Next.js 生产构建通过；Go ranking 测试通过（缓存结果）。
- 使用已有本地 pgvector PostgreSQL 16 镜像创建专用临时容器，认证与 recovery replay 两份集成测试共 4 用例通过。
- 在独立报价测试数据库应用现有 migrations 后，真实重报价用例复现 `constraint fk_risk_quotes_superseded_by does not exist`。根因为运行连接默认 search_path 未包含 agent_market；将 SET CONSTRAINTS 改为 schema 限定名称，保留原有原子替换与重新确认约束。
- 修复后 risk-quote-store 10 用例通过，包含真实 PostgreSQL 重报价与 SQL 执行顺序断言。
- 临时容器以 --rm 创建，测试完成后 docker stop 成功；本地 Colima 已启动。没有修改云数据库或发送链上交易。
- 待继续：其余未覆盖数据库场景、浏览器交互及视觉回归、独立 Review、录屏与生产发布。主 client bundle 526.97 kB（gzip 169.09 kB）触发构建体积提示，待结合加载和交互测量评估。

按《软件设计与思维方法》的小步纠错原则持续推进：从验收项定位缺口，最小范围修复，执行对应 Gate，再保存证据。本文继续作为唯一权威 TODO；L1/L2 是本轮交付范围，L3/L4 保留长期计划。不得用测试通过比例推算产品完成百分比。

- 本轮修复：订单 `start_matching` 内部命令测试补齐 `quoteId` 与 `taskFingerprint`，新增三种缺失报价上下文的拒绝用例；业务契约保持不变。
- 当前本地验证：交易引擎 41 文件、194 用例通过，3 文件、6 用例跳过；共享契约 10 文件、46 用例通过；Web 30 文件、147 用例通过；本地 Agent Runner 6 文件、70 用例通过。
- 类型检查：交易引擎与 Web 通过。Web 类型检查包含仓库既有的公开 Evidence 生成步骤。
- 证据范围：上述均为本地测试；跳过的数据库场景仍需补验。未据此勾选完整产品验收项。
- 下一阶段：核实数据库跳过条件与持久化验收；完成构建及 Go 匹配测试；按真实浏览器用户流程验收路由、Queen DAG、订单、Office 与仲裁；完成独立 Review、录屏 Evidence 和发布。
- 本轮未执行 GitHub 发布、Cloudflare 部署、AWS 触发或 Sepolia 交易。


## 2026-09-01 L2 增补：动态风险定价与 Reputation V2

- [x] 公平匹配确定性基线：硬过滤后默认 `2 历史 + 1 冷启动`，历史不足由新人补位，纯冷启动用可复现 Fisher-Yates 抽满三个不同模型；保存脱敏审计。
- [x] 匹配演进接口：Embedding 仅在合格池内语义召回；训练候选不能绕过准入、风险 Gate 或新人探索契约。真实历史模型训练与影子上线仍属长期运营阶段。
- [x] 模型升级 Gate 契约：baseline/candidate 使用同一冻结、去重、脱敏集，比较质量、正确性、安全、P95、成本和可靠性，先离线再影子运行。

- [x] Risk Assessor 只输出结构化风险因子和原因码，不能直接设置费率或覆盖确定性 Gate。
- [x] Risk Engine 按冻结公式输出 `score/tier/depositRateBps/riskVersion/taskFingerprint`。
- [x] 发布方与 Agent Team 集体对称缴纳保证金；Agent 按份额、节点风险和信誉风险分配。
- [x] R5 强制人工复核；任务、预算、DAG、Agent 或权限变化后重新报价并重新确认。
- [x] Reputation V2 覆盖交付、质量、沟通、责任争议和历史规模，保留衰减窗口与小样本平滑。
- [x] 拒绝自评、关联钱包、重复评价和无资格评价；争议胜诉不扣分。
- [x] 平台不得从裁决方向直接获利；罚没优先补偿守约方，其余进入独立保险/仲裁成本池。
- [x] L2 只实现模拟收益报价；真实 Yield Vault、合约迁移和 DAO 保留到 L3/L4。
- [ ] 设计：`docs/superpowers/specs/2026-09-01-agent-market-risk-pricing-reputation-v2-design.md`。

本文是 Agent Market 当前唯一权威任务清单。完成状态必须由代码、确定性 Gate、独立 Review 与对应环境回读共同决定；本地实现、Cloudflare Web、AWS Runtime 与 Sepolia 链上证据不能互相替代。

## 本轮目标：L1 产品化与 L2 业务闭环

### L1：复用现有能力完成产品化

- [x] Agent 生命周期与版本发布：统一 `draft -> reviewing -> published -> paused -> retired` 状态机，保留版本、审核、暂停、恢复与退役记录。
  - 验收：状态迁移集中在一个深模块中；非法迁移 fail-closed；市场和任务只能选择允许执行的版本。
  - 验收：Agent 详情页显示当前版本、状态、验证边界和变更说明。
- [x] 可解释市场：统一搜索、分类/Tags 硬过滤、排序和推荐原因，不把离线、Owner-only 或未通过准入的 Agent 伪装成可购买对象。
  - 验收：每个候选显示入选原因；被拒绝候选保留脱敏原因码；推荐结果可确定性复现。
- [x] Queen DAG 工作室：提供 ReactFlow 真实 DAG，并允许启动前编辑节点、依赖和 Agent 分配。
  - 验收：确认前可编辑；确认后锁定既有图；Red Team/Repair 只能通过新版本追加；Judge 与 Final Arbiter 独立。
- [x] 钱包交易时间线：任务发布界面分层展示草稿、钱包、YD approval、Escrow 提交与 RPC Receipt 校验；服务端 TransactionVerification 契约单独校验 Receipt/Event，未知状态不投影为成功。
  - 验收：明确区分“未发送”“已广播”“Receipt 成功”“事件已匹配”；错误可恢复且不把超时解释为失败或成功。
- [x] Cocos Office 状态投影：从同一工作流快照投影 Agent、桌位和节点状态。
  - 验收：Cocos 只消费脱敏 `OfficeSnapshotV2` 并只回传 `select-desk`；React/服务端继续持有钱包、执行和下载权限。

### L2：形成可验证业务闭环

- [x] 单 Agent 订单：实现权威订单状态机及报价、注资、匹配、分配、执行、交付、验收/争议、结算/退款和人工复核边界。
  - 验收：订单冻结 Agent 版本、任务要求、预算、验收标准和 Artifact；重复请求幂等；非法迁移 fail-closed。
- [x] 交付、验收与评价资格：只有完成且验收的订单可评价；评价关联订单、Agent 版本和 Evidence。
  - 验收：空交付、越权验收、重复评价和非参与钱包全部被拒绝。
- [x] 正式 Agent Team 契约：Queen、Worker、Judge、Final Arbiter、Red Team 与 Repair 均有 Role/Context/Input/Output/Artifact/失败路由，真实适配器强制独立角色。
  - 验收：节点权限最小化；上下文隔离；失败只回到责任节点；最终状态由 Gate 决定。
- [x] 信誉与反作弊基础：复用 90 天窗口、最近 20 次、30 天半衰期和新人初始分，加入验收率、争议率、准时率及低样本平滑。
  - 验收：baseline/candidate 使用同一冻结数据集；关联评价与异常行为只能降权或进入人工复核，不能静默改写历史。
- [x] Escrow、退款、质押、罚没、售后与仲裁已有本地确定性契约、UI 状态边界与既有 V3 Sepolia 独立证据；本轮没有发送新交易。
  - 验收：Intent、钱包交易、Receipt、匹配事件和业务投影逐层可见；资金位置不明时进入 `manual_review`，禁止自动重复支付。

## 长期计划：本轮不宣称完成

### L3：平台商业化

- [ ] 多 Agent 套餐、父订单与节点子订单；子订单独立执行和验收，父订单聚合交付与预算。
- [ ] 多 Provider 收益策略、Receipt、PayoutManifest 与 Claim。
- [ ] 平台费、节点收益、退款和罚没的统一账本与可对账投影。

### L4：成熟运营治理

- [ ] 运营告警、分级响应、补偿扫描、DLQ 与 `manual_review` 急停。
- [ ] Agent 发布门禁、版本回滚、问题工单和售后处理。
- [ ] 资金对账、高风险双人复核、关联账户检测与完整审计日志。

## 最终 UI 收尾

- [x] 修正模块等高布局：当前同一行所有模块按最高模块统一高度，导致内容较少的模块底部出现大块空白。调整为内容自适应高度；如必须保留网格对齐，仅对明确需要对齐的局部组件设置最小高度，不使用整组强制等高。
  - 验收：桌面端各模块高度随内容变化，无明显无意义底部空白。
  - 验收：H5 纵向排列不继承桌面端固定高度。
  - 验收：在 375、390、430、1440 px 复核布局，不产生横向溢出或内容截断。
  - 状态：已实现内容自适应规则；纳入 375、390、430、1440 px 最终回归。

## 本地产品闭环

- [x] GraphQL 多 Agent 成功、Provider 失败、超时、取消、幂等重试和独立 Judge / Final Arbiter。
- [x] Personal Code/Image Agent 精确 manifest identity、Owner Scope、签名 Runtime smoke；Image 使用 `2fa405e1...` manifest digest，`4bba2f8f...` 仅作为 GGUF layer SHA。
- [x] 任务发布、质押和委员会链交互适配完成本地 Gate；未发送新的 Sepolia 交易。
- [x] Cocos Creator 3.8.8 虚拟办公室、本地截图、架构、PRD 和脱敏 Evidence。
- [x] 16 个路由在 375、390、430、1440、1920 像素下共 80 个组合通过可视回归。
- [x] 全仓 `pnpm verify` 通过；仓库策略、Evidence、TypeScript、Solidity、Go 与 Python Gate 均通过。

## 交付与外部边界

- [x] 修复 Cloudflare 未代理 `/api/chain/position` 的生产缺陷；PR #22 合并为 `93bcd5c`，Cloudflare Production deployment `33501a71-71dc-434f-9daf-0af0ba1ec91f`。
- [ ] 重新录制修复后的外置 Chrome 全流程；只在需要补足当前网页链路证据时发送最小 Sepolia 测试网交易，必须保留精确 Receipt/Event 回读且不得泄露签名消息、Cookie 或内部临时 Endpoint。
- [ ] 完成本轮 L1/L2 独立 Review、Feature QA、PR、Cloudflare Preview 与 Production 语义回读。
- [ ] AWS V2 新鲜性能回读仅在独占写锁、预算 Gate 和最小复用方案满足时执行；禁止修改 Free 计划或创建重复共享基础设施。
- [x] V3 Sepolia 合约与既有 24 笔交互闭环已有独立生产证据；新录屏只补网页端当前版本链路，不覆盖或重复既有链上事实。
