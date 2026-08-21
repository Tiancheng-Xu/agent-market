# ADR 0001: Defer The Graph in Phase 2 / 二期暂缓 The Graph

- Status / 状态: `accepted`, delivery status `deferred`
- Date / 日期: 2026-08-21

## Decision / 决策

Phase 2 uses direct Sepolia RPC receipt and log verification as the acceptance authority, then uses Blockscout as an independent reconciliation surface. The Graph is not part of the Phase 2 critical path.

二期以 Sepolia RPC 的 receipt 与 event log 精确校验作为验收权威，再使用 Blockscout 作为独立对账界面。The Graph 不进入二期关键路径。

## Why now / 当前原因

- Current flows validate a bounded number of known transactions by hash, contract address, event topic, request reference, chain ID, and confirmation state.
- RPC is the shortest authority path for exact receipt and event verification. Blockscout adds a second source without an indexing deployment and synchronization boundary.
- A subgraph would add schema design, mappings, deployment credentials, indexing lag, reorg handling, migration, monitoring, and another external availability dependency before historical query volume requires them.
- 当前流程只需按交易哈希、合约地址、事件 topic、request reference、chain ID 和确认状态校验有限数量的已知交易。
- RPC 是精确回执与事件校验的最短权威路径；Blockscout 提供第二数据源，同时不引入索引部署与同步边界。
- 在历史查询量尚未形成前，subgraph 会提前增加 schema、mapping、部署凭据、索引延迟、reorg、迁移、监控和额外可用性依赖。

## Triggers / 触发条件

Migration planning starts when any two conditions persist for two release cycles:

- A user query needs more than 200 historical events or more than three RPC pagination requests.
- P95 read latency for Evidence or portfolio history exceeds 1.5 seconds after bounded caching.
- RPC provider rate limits or archive requirements prevent deterministic readback.
- Two or more product views require joins across task, escrow, settlement, staking, or arbitration events.
- Reconciliation backlog exceeds 1,000 events or six hours.

当以下任意两个条件连续两个发布周期成立时，启动迁移规划：

- 单次用户查询需要超过 200 条历史事件，或超过三次 RPC 分页请求。
- 在有界缓存后，Evidence 或历史视图 P95 读取延迟仍超过 1.5 秒。
- RPC provider 限流或 archive 要求阻碍确定性回读。
- 两个以上产品视图需要跨任务、托管、结算、质押或仲裁事件关联查询。
- 对账积压超过 1,000 个事件或六小时。

## Migration path / 迁移路径

1. Freeze versioned event entities and map contract address, chain ID, block number, transaction hash, log index, request reference, and finality state.
2. Build and locally test mappings against captured public Sepolia fixtures; never place private endpoints or deploy keys in the subgraph.
3. Run shadow indexing while RPC remains authoritative, comparing counts and exact event identities with Blockscout.
4. Require reorg, lag, schema migration, replay, and rollback runbooks before exposing indexed reads.
5. Move read-heavy history views first. Transaction acceptance continues to require direct RPC receipt and exact event verification.

1. 冻结版本化 event entity，映射合约地址、chain ID、区块号、交易哈希、log index、request reference 与 finality 状态。
2. 使用已公开的 Sepolia fixture 在本地构建和测试 mapping；subgraph 中不得包含私有 endpoint 或 deploy key。
3. 在 RPC 仍为权威来源时执行 shadow indexing，并与 Blockscout 比对数量和精确事件身份。
4. 在开放索引读取前，必须具备 reorg、延迟、schema migration、replay 与 rollback 手册。
5. 先迁移高读取量历史视图；交易成功验收仍要求直接 RPC receipt 与精确 event 校验。

## Consequences / 影响

Phase 2 avoids an unnecessary external runtime and keeps success verification close to chain authority. Historical aggregation remains less convenient until the triggers justify The Graph.

二期避免不必要的外部运行时，并让成功校验贴近链上权威。在触发条件成立前，历史聚合查询会相对不便，这是明确接受的权衡。
