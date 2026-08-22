# Agent Market UI 全链路走查与性能查漏

日期：2026-08-22

项目：Agent Market

结论：本轮只交付 Agent Market，不把 Web3 作业当成目标项目。Web3 作业只作为查漏补缺清单，帮助确认 Agent Market 是否具备可交付项目应有的证据层：SSR/水合、性能观测、全链路页面截图、边界说明和待补验项。

## 1. 本轮范围

已验证：

- 本地生产构建后的预览站点可打开主要路由。
- 外置 Chrome 已置顶并通过浏览器截图接口重新截图，截图不包含会议窗口、Dock 或浏览器工具栏。
- 顶部全局搜索输入 `staking` 后显示结果，回车跳转到 `/staking`。
- 任务发布页 `Expert type` 已是下拉框。
- 点击 `Validate draft` 在空表单时有反馈。
- 填写任务草稿后可触发草稿校验状态，并可点击 `Preview transaction states` 得到预览反馈。
- 375、390、430、1440 宽首页均无根级横向溢出。
- Evidence 页本地 CDP 性能采集完成。

未执行：

- 未连接 MetaMask 发起真实钱包授权、签名或交易。原因：钱包授权会暴露账户地址并改变用户钱包授权状态，需要用户在场确认。
- 未启动新的 AWS 性能链路。原因：当前任务没有要求新增付费资源；性能生产证据沿用已归档的 AWS 读回样本。
- 未执行生产域名切换。原因：生产发布和自定义域名切换仍是人工 Gate。

## 2. 页面截图清单

| # | 路由 | 操作 | 截图 | 状态 |
|---|---|---|---|---|
| 01 | `/` | 首页打开 | [01-home](../ui-screenshots/2026-08-22/final/01-home.png) | 通过 |
| 02 | `/agents` | Agent 列表打开 | [02-agents](../ui-screenshots/2026-08-22/final/02-agents.png) | 通过 |
| 03 | `/agents/new` | Agent 注册页打开 | [03-agent-register](../ui-screenshots/2026-08-22/final/03-agent-register.png) | 通过 |
| 04 | `/agents/atlas-research` | Atlas Agent 详情打开 | [04-agent-profile-atlas](../ui-screenshots/2026-08-22/final/04-agent-profile-atlas.png) | 通过 |
| 05 | `/agents/forge-data` | Forge Agent 详情打开 | [05-agent-profile-forge](../ui-screenshots/2026-08-22/final/05-agent-profile-forge.png) | 通过 |
| 06 | `/agents/pulse-copy` | Pulse Agent 详情打开 | [06-agent-profile-pulse](../ui-screenshots/2026-08-22/final/06-agent-profile-pulse.png) | 通过 |
| 07 | `/agents/local` | 本地/公开 API Agent 状态页打开 | [07-local-agents](../ui-screenshots/2026-08-22/final/07-local-agents.png) | 通过 |
| 08 | `/tasks` | Task 列表打开 | [08-tasks](../ui-screenshots/2026-08-22/final/08-tasks.png) | 通过 |
| 09 | `/tasks/new` | Task 发布页打开 | [09-task-publish](../ui-screenshots/2026-08-22/final/09-task-publish.png) | 通过 |
| 10 | `/tasks/task-research-brief` | Research task 详情打开 | [10-task-detail-research](../ui-screenshots/2026-08-22/final/10-task-detail-research.png) | 通过 |
| 11 | `/tasks/task-normalize-data` | Data task 详情打开 | [11-task-detail-data](../ui-screenshots/2026-08-22/final/11-task-detail-data.png) | 通过 |
| 12 | `/tasks/task-onboarding-copy` | Copy task 详情打开 | [12-task-detail-copy](../ui-screenshots/2026-08-22/final/12-task-detail-copy.png) | 通过 |
| 13 | `/dashboard` | Dashboard 打开 | [13-dashboard](../ui-screenshots/2026-08-22/final/13-dashboard.png) | 通过 |
| 14 | `/staking` | Staking 打开 | [14-staking](../ui-screenshots/2026-08-22/final/14-staking.png) | 通过 |
| 15 | `/committee` | Committee 打开 | [15-committee](../ui-screenshots/2026-08-22/final/15-committee.png) | 通过 |
| 16 | `/ops` | Ops 打开 | [16-ops](../ui-screenshots/2026-08-22/final/16-ops.png) | 通过 |
| 17 | `/evidence` | Evidence 打开 | [17-evidence](../ui-screenshots/2026-08-22/final/17-evidence.png) | 通过 |
| 18 | `/missing-agent-market-route` | 404 路由打开 | [18-not-found](../ui-screenshots/2026-08-22/final/18-not-found.png) | 通过 |

## 3. 关键交互截图

| # | 交互 | 验证结果 | 截图 |
|---|---|---|---|
| 19 | 顶部搜索输入 `staking` | 出现 Staking 结果，回车跳转 `/staking` | [19-global-search-staking](../ui-screenshots/2026-08-22/final/19-global-search-staking.png) |
| 20 | 空表单点击 `Validate draft` | 出现必填项反馈 | [20-task-validate-empty-feedback](../ui-screenshots/2026-08-22/final/20-task-validate-empty-feedback.png) |
| 21 | `Expert type` 选择 `Data analyst` | 下拉框可选并显示选中值 | [21-task-expert-type-dropdown-selected](../ui-screenshots/2026-08-22/final/21-task-expert-type-dropdown-selected.png) |
| 22 | 填写任务后点击 `Validate draft` | 页面进入 `Draft validated` 状态 | [22-task-validate-filled-feedback](../ui-screenshots/2026-08-22/final/22-task-validate-filled-feedback.png) |
| 23 | 点击 `Preview transaction states` | 显示 `Preview only: approve YD -> submit escrow -> wait for RPC receipt. No wallet transaction was sent.` | [23-task-preview-transaction-feedback](../ui-screenshots/2026-08-22/final/23-task-preview-transaction-feedback.png) |

## 4. 响应式截图与结果

| 断点 | 横向溢出 | 截图 |
|---|---:|---|
| 375 | 无 | [24-responsive-home-375](../ui-screenshots/2026-08-22/final/24-responsive-home-375.png) |
| 390 | 无 | [24-responsive-home-390](../ui-screenshots/2026-08-22/final/24-responsive-home-390.png) |
| 430 | 无 | [24-responsive-home-430](../ui-screenshots/2026-08-22/final/24-responsive-home-430.png) |
| 1440 | 无 | [24-responsive-home-1440](../ui-screenshots/2026-08-22/final/24-responsive-home-1440.png) |

## 5. 性能与 SSR 查漏

本轮本地 CDP 采集：

- 页面：`/evidence`
- `responseEnd`: 19 ms
- `domContentLoaded`: 109 ms
- `loadEvent`: 260 ms
- `first-paint`: 116 ms
- `first-contentful-paint`: 176 ms
- `largest-contentful-paint`: 176 ms
- 资源数：11
- 资源 encoded body：152844 bytes
- 最大 JS：`index-DEBuf4b5.js`，101116 bytes encoded body
- 最大 CSS：`index-DZOJ7Xx9.css`，8462 bytes encoded body

生产性能归档证据：

- `docs/evidence/testing/2026-08-20-performance-observability.json`
- 状态：`PRODUCTION_SAMPLE_VERIFIED_PUBLIC_READBACK_COMPLETE_AWS_PAUSED`
- 归档样本 LCP：1192 ms
- errorRate：0
- AWS 消费端已暂停，队列为 0。

判断：

- Agent Market 当前版有本地浏览器性能证据，也有已归档的生产读回样本。
- 本轮没有重新启动 AWS 做新性能样本，不能把本轮写成“新跑了一次 AWS 全链路”。
- 后续上线预览后，应再跑一次 Cloudflare Preview 的真实浏览器性能采样，并把 Preview URL、commit、FCP/LCP、SSR header、hydration 结果补入 Evidence。

## 6. Web3 作业式缺口矩阵，只用于 Agent Market 查漏

| 维度 | Agent Market 当前状态 | 缺口处理 |
|---|---|---|
| 架构图/时序图 | Evidence 页面已有架构与流程证据 | 保持 |
| Edge SSR | 已有 Pages SSR 路由修复和预览验证记录 | 推送后复测最新 Preview |
| Hydration | 已有 SSR/CSR fallback 设计与测试 | 推送后复测最新 Preview |
| 性能观测 | 本地 CDP + 归档 AWS 样本 | 新 Preview 再补一次真实浏览器采样 |
| Web3 钱包 | UI 有 Sepolia 与 MetaMask 边界 | 真实钱包授权/签名/交易待用户在场验证 |
| 链上交易 | 当前不声明新链上完成 | 如作业要求强制链上闭环，再单独授权执行 |
| 多 Agent 编排 | 已按 Queen/DAG/GraphQL/Final Arbiter 方向实现 | 继续以 Agent Market 自身流程为主 |
| 本地模型/API Agent | Local Ollama 与公开 API Agent 已纳入设计与 UI | 继续补 provider key 的真实调用证据 |
| Evidence 完整性 | 页面、交互、响应式、性能已有新留痕 | 推送后补 CI、PR、Cloudflare Preview |

## 7. 当前待办

1. 跑本地完整校验。
2. 提交并推送当前 UI/性能/Evidence 变更。
3. 等 GitHub Action 和 Cloudflare Preview。
4. 对最新 Preview 复测 `/evidence`、`/agents/local`、`/agent/healthz`、404、SSR header、水合边界。
5. 用户在场时再测 MetaMask 授权、签名或交易链路。
