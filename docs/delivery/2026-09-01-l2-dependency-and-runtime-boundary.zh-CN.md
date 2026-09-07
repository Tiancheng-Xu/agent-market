# Agent Market L2 依赖与 Runtime 边界

日期：2026-09-01

## 结论

| 候选 | 决策 | 实际用途 | 回滚方式 |
| --- | --- | --- | --- |
| `@tanstack/react-query@^5.102.8` | 有界采用 | 仅用于订单、Reputation 等服务端状态；不接管钱包签名和链上 Intent | 移除订单路由 Query Boundary，恢复严格 API client 的直接调用 |
| `@xyflow/react@^12.11.5` | 保留现有 | 真实 Queen typed DAG 的只读运行视图和草稿编辑模式 | 恢复只读 Flow；文本草稿与 `AmendTaskGraph` 仍可独立工作 |
| `motion` | 拒绝 | 现有 CSS 已覆盖状态过渡和 reduced-motion | 无新增依赖，无需回滚 |
| `pixelmatch@^7.2.0` + `pngjs@^7.0.0` | 开发依赖 | 同一 Chrome 环境下比较生产基线与候选截图，所有差异必须人工审阅 | 删除比较脚本和开发依赖，不影响运行时 |

## 被替代的样板

- 订单读取和 Reputation 读取不再各自维护 `useEffect + loading + error`。
- 订单命令使用 mutation，成功后按 query key 失效并刷新相关投影。
- Query 默认 `staleTime=30s`、`retry=false`，避免 Hydration 后立刻重复请求或把离线状态重试成假成功。
- `/tasks/:id` 与 `/agents/local` 改为路由级懒加载；首页不加载 React Query 或 XYFlow。

## 构建体积

2026-09-01 本地 production build：

| Chunk | 原始大小 | Gzip | 判定 |
| --- | ---: | ---: | --- |
| `OrderDetailRoute` | 57,595 B | 18,218 B | 低于单路由新增 30KB Gate |
| `LocalAgentsPage` | 212,860 B | 69,343 B | 业务专属 XYFlow 大块；已与首页隔离 |
| 首页公共 `index` | 526,779 B | 168,995 B | React Query 来源模块 0，XYFlow 已拆离 |

Sourcemap 检查：React Query 的 25 个来源模块只存在于 `OrderDetailRoute` chunk；首页和 Live chunk 均为 0。

## SSR / Hydration 边界

- 服务端每次渲染创建独立 QueryClient，避免跨请求缓存泄漏。
- 浏览器端才复用 QueryClient。
- 懒加载 fallback 固定最小高度，核心 SSR 文案不依赖客户端时间、钱包或 viewport。
- Worker 只代理精确 UUID API 路由；公开 Reputation GET 不转发 Session Cookie。
- 未知路由继续返回真实 404。

## 生产数据边界

- Risk Engine、Risk Assessor 协议、Reputation V2 公式、报价确认 Gate：`verified-local`。
- `0015` 和 `0016` migration：已编写并通过静态/单元 Gate；本轮没有在生产数据库执行。
- 生产 RiskTaskSource 和 Reputation V2 Store：代码已实现；缺表、缺绑定、缺评分或缺权重时 fail closed。
- 生产 Risk Assessor client：尚未配置，因此新报价创建仍明确返回 `503`。
- `taskFingerprint` bootstrap API：已实现；数据源不可用时返回 `503`，浏览器不能自造指纹。
- 对称保证金和动态风险费率：仅为 L2 报价/确认模型，当前 Sepolia V3 合约尚未执行。
- 本轮没有触发 AWS，没有发送新的 Sepolia 交易。

## 已知范围外 Gate

`pnpm peers check` 仍报告既有 Hardhat 版本范围：仓库安装 `2.26.3`，`@nomicfoundation/hardhat-ethers@3.1.3` 要求 `^2.28.0`。本轮不升级合约工具链，避免把 UI/公平机制交付扩成链开发环境迁移。
