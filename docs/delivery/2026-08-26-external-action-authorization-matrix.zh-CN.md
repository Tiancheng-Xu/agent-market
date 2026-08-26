# Agent Market 外部动作一次性授权矩阵

状态：`approval-required`。本文不是授权记录，也不是部署或交易证据。

## 共同硬边界

- 目标 AWS 区域固定为 `us-east-1`；账号标识不进入公开文档。
- 动作前必须取得新的 AWS 只读身份、栈状态、Change Set、队列、Consumer Mapping、ECS Running Task 与预算回读。
- 禁止新建或替换 NAT Gateway、RDS/Aurora、VPC、ECS Cluster、ALB、OIDC Provider 和共享制品桶。
- 禁止删除共享资源、清空队列、暴露凭据、发布模型权重或把本地 Gate 写成生产完成。
- 任何 Change Set 出现受保护资源替换、月度固定成本或范围外资源时立即停止并重新确认。

## 复用与成本矩阵

| 资源/动作 | 现有候选 | 决策 | 隔离方式 | 单次增量成本上限 | 回滚/清理责任 |
| --- | --- | --- | --- | --- | --- |
| CloudFormation 栈 | `agent-market-performance` | 原栈更新，不另建平行栈 | 项目 Tags、逻辑资源 ID、Change Set 审核 | Change Set 本身无应用运行费 | Agent Market；失败则不执行 Change Set |
| VPC / Subnet / NAT | 已验证共享课程基础设施 | 必须复用 | 项目安全组、最小入站规则 | 不允许新增固定成本 | 共享平台保护，项目不得删除 |
| PostgreSQL | 已验证共享 PostgreSQL | 必须复用 | 独立 Schema/Role、最小 SG ingress | 不新增数据库实例；已有基线不算本次增量 | 共享平台保护；仅清理项目 Schema |
| ECS Cluster | 既有/共享 Cluster，需动作前只读确认 | 必须复用；禁止新建 | Task Definition、Task Role、`startedBy` 与 Tags | Cluster 无额外实例；Fargate 单短任务硬上限 `$0.02` | 完成后 Running Task 必须为 0 |
| API Gateway HTTP API | 既有项目 API | 更新或复用 | HMAC、Origin allowlist、项目 Route | 单样本远低于 `$0.01` | 保留项目 Route；失败时回滚栈 |
| Lambda | 既有 Ingestion / Dispatcher | 更新代码与配置，不复制函数 | 项目 IAM、日志组、并发限制 | 单样本远低于 `$0.01` | 恢复上一版本或回滚栈 |
| SNS + SQS / DLQ | 既有 Topic、Work Queue、DLQ | 必须复用 | request_id/run_id、SSE、重试与 DLQ | 单样本远低于 `$0.01` | 不清空队列；恢复 Consumer pause |
| ECR | 既有项目 Repository | 仅推不可变 Digest；不建第二仓库 | Digest + 生命周期策略 | 新增镜像存储硬上限 `$0.01/天` | 保留 Evidence 后按既有生命周期处理 |
| CloudWatch | 既有项目日志组 | 复用短保留期 | 脱敏原因码，不记录 Prompt/Body | 单样本硬上限 `$0.01` | 不创建 Dashboard 或自定义长期指标 |
| Sepolia V3 合约 | 尚未部署 | 只在授权后部署并精确回读 | 新合约地址、交易哈希、事件与版本清单 | 仅测试网 Gas；总硬上限 `0.02 SepoliaETH` | 不破坏 V2；失败停止，不重复盲发 |
| 网页端链交互 | 现有 unsigned-intent Adapter | 只发送授权范围内的测试交易 | MetaMask Account 1 本机签名；服务端定义 intent | 包含在 `0.02 SepoliaETH` 总上限 | 每笔必须 receipt/event 回读；拒绝即停止 |
| Cloudflare | 现有 Pages 项目 | 本轮先 Preview；生产仍单独人工确认 | Preview deployment + 深链/404 回读 | 不新增付费产品 | Preview 可废弃；不改正式域名 |

## 建议一次性授权范围

1. 允许创建并只读审查 AWS Change Set；仅当没有受保护资源替换和新增固定成本时执行。
2. 允许临时恢复 Consumer，投递一条 UUIDv7 + HMAC 性能样本，完成 API Gateway → Lambda → SNS → SQS → Dispatcher → ECS → PostgreSQL 全链回读后立即再次暂停。
3. 允许执行 Sepolia V3 部署与最小闭环测试，累计 Gas 上限 `0.02 SepoliaETH`；任何主网、真实资产或超预算动作均禁止。
4. 允许创建 Cloudflare Preview 和 PR；不允许生产发布、正式域名切换或付费 Cloudflare 产品。

## 验收与停止条件

- AWS：同一 `request_id` / `run_id` 可从入口追踪到 PostgreSQL；DLQ 为 0；Consumer 最终为 Disabled；ECS Running Task 为 0；队列不做破坏性清空。
- Sepolia：每笔交易必须有 chainId、合约地址、transaction hash、block、status、精确事件与独立 RPC/浏览器回读。
- Cloudflare：Preview 首页、深链和 Evidence 返回 200，未知路由返回真实 404，公开内容 Gate 无密钥/私有路径。
- 任一身份、预算、Change Set、Gas estimate、receipt 或回读不满足即停止，不用 UI 状态补证。

## 价格依据

- AWS API Gateway HTTP API 官方示例为前 3 亿次请求 `$1.00/百万次`：https://aws.amazon.com/api-gateway/pricing/
- SQS 每月前 100 万次请求免费，跨同区域服务不收 SQS 数据传输费：https://aws.amazon.com/sqs/pricing/
- SNS 官方说明前 100 万次请求免费，超出后 `$0.50/百万次`：https://aws.amazon.com/sns/faqs/
- Fargate 按 vCPU、内存和运行秒数计费，官方 us-east-1 示例用于上述单短任务上限：https://aws.amazon.com/fargate/pricing/

## 当前未满足的动作前 Gate

- 2026-08-26 当前 shell 无可用 AWS CLI 身份，尚未取得新的实时资源盘点；旧 Evidence 只能证明其记录时点。
- MetaMask 当前锁定；必须由用户在本机扩展中自行解锁，密码不得进入聊天、日志或录屏台账。
