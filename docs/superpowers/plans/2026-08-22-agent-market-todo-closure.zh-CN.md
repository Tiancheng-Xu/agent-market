# Agent Market 二期待办收口实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 收口 Evidence 真值、浏览器性能降级、Owner Agent 持久化、模型评分闭环和 LangChain 节点适配，同时保持现有 Mastra、LangGraph、GraphQL 与零信任边界。

**架构：** Cloudflare 继续负责 Edge SSR、公开页面和性能入口；浏览器只保存公开 Agent metadata，不保存 API key、Ollama 地址或原始 prompt。Local Runtime 负责 Owner 身份范围、模型调用和本地持久状态；Mastra 管理顶层 workflow，LangGraph 管理有状态分支，LangChain 只组合单节点模型、prompt 和 tool 调用。

**技术栈：** React 19、TypeScript、Vite、Cloudflare Pages Worker、Mastra、LangGraph、LangChain、Zod、Vitest。

**规格：** `docs/superpowers/specs/2026-08-22-agent-market-local-ollama-agent/design.md`

## 全局约束

- Ollama 只能连接 `127.0.0.1:11434`，浏览器和公网不得直接访问。
- API key、签名 secret、完整 prompt、模型权重、私有路径不得进入前端、日志或公开 Evidence。
- 用户添加的本地 Agent 默认 `private + owner-only`；无 Owner scope 时不可被公开任务选择。
- 三候选必须按 `modelTag` 去重；Judge 与 Final Arbiter 必须上下文隔离且不能自己审自己。
- 没有外部回读不得标记 `verified-production`。
- AWS 只复用现有 `agent-market-performance` 栈，不新建付费基础设施；验证后恢复暂停。

---

### Task 1：Evidence 真值收口

**文件：**
- 修改：`apps/web/src/pages/EvidencePage.tsx`
- 新增：`docs/evidence/deployment/2026-08-22-agent-orchestration-production.json`

**接口：** Evidence 继续消费生成台账；页面不硬编码会随每次发布变化的 deployment ID。

- [ ] 将 Sepolia 显示为 RPC + Etherscan `verified-production`，Blockscout PRO 单独标记增强待办。
- [ ] 将 V2 AWS runtime 与 external delivery 保持 `pending-external`。
- [ ] 记录 PR、merge commit、Cloudflare deployment、SSR、404、1920 与 Agent catalog 回读。
- [ ] 运行 Evidence validator 与 Web 测试。

### Task 2：浏览器性能降级和 Web Vitals

**文件：**
- 新增：`apps/web/src/performance/degradation.ts`
- 新增：`apps/web/src/performance/degradation.test.ts`
- 修改：`apps/web/src/performance/collector.ts`
- 修改：`apps/web/src/performance/collector.test.ts`
- 修改：`apps/web/src/main.tsx`
- 修改：`apps/web/src/components/Shell.tsx`
- 修改：`apps/web/src/styles.css`

**接口：** `detectClientCapability()` 返回 `normal | degraded` 与脱敏 reason codes；`startPerformanceCollection()` 超时或网络失败时只返回失败状态，不产生未处理异常。

- [ ] 用 `saveData`、`effectiveType`、`deviceMemory`、`hardwareConcurrency` 判定降级，不采集指纹原值。
- [ ] 在 HTML 上设置 `data-performance-mode`，弱设备关闭重动画并延迟 Evidence 大图。
- [ ] Shell 显示统一 degraded/offline/timeout 提示，不伪造成功。
- [ ] 性能 POST 添加有界超时、失败吞吐和同一 request ID。
- [ ] 覆盖 normal、slow network、low memory、timeout、unsupported API 测试。

### Task 3：Owner Agent 持久化与授权

**文件：**
- 新增：`apps/web/src/agent-owner-store.ts`
- 新增：`apps/web/src/agent-owner-store.test.ts`
- 修改：`apps/web/src/pages/LocalAgentsPage.tsx`
- 修改：`packages/shared-contracts/src/local-agent.ts`
- 修改：`packages/shared-contracts/src/local-agent.test.ts`

**接口：** IndexedDB 只保存公开 Manifest metadata，并以已认证钱包地址派生的 Owner scope 分区；凭据只存在 Local Runtime 环境。

- [ ] 定义 owner identity、schema version、createdAt/updatedAt 和软删除字段。
- [ ] 禁止持久化 key、secret、endpoint credential、完整 prompt 与本地路径。
- [ ] 未连接钱包时只允许查看，不允许新增或选择 Owner Agent。
- [ ] 公共任务始终过滤 `owner-only` Agent。

### Task 4：评分与 Learning Loop 持久化

**文件：**
- 新增：`apps/local-agent-runner/src/agent-score-store.ts`
- 新增：`apps/local-agent-runner/src/agent-score-store.test.ts`
- 修改：`apps/local-agent-runner/src/queen-ranking.ts`
- 修改：`apps/local-agent-runner/src/queen-ranking.test.ts`
- 修改：`apps/local-agent-runner/src/queen-orchestrator.ts`

**接口：** `AgentScoreStore` 以 Agent/模型身份读取历史分，按成功、失败、Judge 分和延迟写入脱敏 outcome；写入幂等键为 `taskId + nodeId + runId`。

- [ ] 新模型零历史分并获得有界探索加分。
- [ ] 完成后按结果加减分，失败写入 reason code，不写原始输出。
- [ ] 老模型连续低分后标记 retired，仍保留 Evidence 审计记录。
- [ ] 排名继续执行 capability、license、health、owner scope 和 modelTag 去重硬过滤。

### Task 5：LangChain 节点适配

**文件：**
- 修改：`apps/local-agent-runner/package.json`
- 新增：`apps/local-agent-runner/src/langchain-node-adapter.ts`
- 新增：`apps/local-agent-runner/src/langchain-node-adapter.test.ts`
- 修改：`apps/local-agent-runner/src/queen-workflow-runtime.ts`

**接口：** LangChain adapter 只包装单节点 invoke；Mastra 仍是顶层 workflow，LangGraph 仍是有状态图和恢复边界。

- [ ] 用 `RunnableLambda` 组合节点输入、模型调用和结构化输出。
- [ ] 传递 requestId/runId/nodeId，不传 API key 或未脱敏 Memory。
- [ ] timeout/cancel 映射为稳定错误码，由 LangGraph 决定 repair 或升级。
- [ ] 测试三层边界均真实执行且职责不重叠。

### Task 6：交付 Gate 与 AWS 外部验证

**文件：**
- 修改：`docs/evidence/deployment/*`（只写脱敏真实回读）

**接口：** 本地和远端 Gate 通过后创建 PR/Preview；生产仍由 Cloudflare Git Integration 发布。AWS 验证复用现有队列、Lambda、ECS 与 PostgreSQL，并在证据回读后恢复暂停。

- [ ] 运行目标测试、typecheck、build、repository/evidence policy 和完整 `pnpm verify`。
- [ ] 检查 375、390、430、1440、1920，无横向溢出或破图。
- [ ] Preview 验证 SSR、hydration、真实 404、degraded mode 和 Agent catalog。
- [ ] 合并后验证自定义域名与不可变 deployment URL。
- [ ] AWS 只执行一次 V2 性能样本，记录 request ID/run ID、查询回读和截图，随后恢复 consumer disabled 与 ECS running=0。
## 后续 UI / i18n 巡检 TODO（不阻塞当前主线）

- 逐页检查中文模式，覆盖静态文案、动态 Agent catalog 文案、状态标签和表单反馈。
- 将 i18n 独立 Gate 扩展到动态数据源，防止中文页面混入英文说明。
- 全局检查 Evidence 架构图和截图的对比度、完整缩放、点击查看原图及 1920/375/390/430 适配。
