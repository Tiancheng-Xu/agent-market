# Agent Market 关机恢复检查点

记录时间：2026-08-20（America/New_York）

## 工作区

- 仓库：`/Users/shier/Desktop/repos/agent-market`
- 当前 worktree：`/Users/shier/Desktop/repos/agent-market/.worktrees/foundation-batch-1`
- 分支：`feature/foundation-batch-1`
- 已提交双语设计：`9a02fc1`
- 已提交双语实现计划：`9b31188`
- 本轮代码、Evidence、截图和 IaC 修改尚未提交，且尚未执行最终测试。

## 已验证状态

- Cloudflare Worker 预览：`https://agent-market-web.271251549.workers.dev`
- Worker SSR 已验证：`/evidence` 与任务工作台返回 `200 + x-agent-market-render-mode:ssr`；未知路由返回真实 `404 + SSR`。
- AWS 栈 `agent-market-performance` 位于 `us-east-1`。
- AWS 栈于 `2026-08-20T23:09:46Z` 完成更新，状态为 `UPDATE_COMPLETE`。
- `PerformanceWorkQueue` 与 `PerformanceDeadLetterQueue` 已从 `alias/aws/sqs` 改为 `SqsManagedSseEnabled: true`，保留静态加密且无需新增客户托管 KMS Key。
- 修复前 CloudWatch SNS 指标：发布 5、交付成功 0、交付失败 5；根因为 SNS 无法向使用 AWS 管理 KMS Key 的订阅队列交付。
- 诊断性能负载经 Worker/API 返回 `202 accepted`。该诊断不作为最终 Evidence 样本。
- 已生成并目视检查两张脱敏截图：
  - `apps/web/public/evidence/aws-cloudformation-stack.png`
  - `apps/web/public/evidence/github-actions-success.png`
- 截图不包含账号 ID、邮箱、ARN、密钥、端点或无关资源。

## 已修改但待验证

- 新增整站中英双语层：`Locale = en | zh-CN`、类型安全字典、Provider、持久化偏好与 `中文 / EN` 切换。
- 全部页面组件已接入 `Localized` 包装；服务端与首次客户端渲染保持英文，hydration 后才读取偏好。
- Evidence 页面已替换截图空状态，准备展示 AWS、GitHub Actions、Cloudflare SSR 和 AWS runtime 四张图。
- Evidence 中“未部署 AWS/Cloudflare”的过期限制已改为当前真实待办边界。
- Cloudflare Worker Static Assets 配置和 Pages/Worker 双产物构建修复尚未提交。
- 上述代码尚未运行 TypeScript、Vitest、build 或响应式检查，不得声称通过。

## 待完成

1. 修复后重新打开 Worker `/evidence`，等待 5 秒以上触发真实浏览器 Web Vitals。
2. 验证 SNS 成功交付、Dispatcher Lambda 触发、ECS 短任务启动并 `exitCode=0`。
3. 从 PostgreSQL 回读同一 `request_id` 的指标样本，更新性能 Evidence JSON。
4. 截取并脱敏 `aws-runtime-exit-zero.png` 与 `cloudflare-edge-ssr.png`。
5. 运行双语单测、Web 全测、TypeScript、build 和仓库 `pnpm verify`。
6. 用内置浏览器检查中文/英文、375/390/430/1440 px、Evidence 图片和真实 404。
7. 验证通过后，将 `agent-market.baby2b.online` 从 Pages 切换到 Worker。
8. 正式域名再跑一次性能样本并完成公开 Evidence 回读。
9. 仅在 Evidence 留存和公开回读成功后，执行 `scripts/aws/pause-agent-market.sh pause`；确认映射 Disabled、ECS running=0。
10. 提交、推送、等待 GitHub Actions 成功并部署最终 Cloudflare 版本。

## 诚实边界

- AWS 栈和队列加密修复已验证完成。
- 修复后的 SNS→SQS→Dispatcher→ECS→PostgreSQL 全链路尚未复测，不得标记完成。
- 双语功能已写入但尚未编译或测试，不得标记完成。
- 正式域名仍指向既有 Pages 项目，尚未切换到 Worker。
- AWS 消费端尚未暂停；此时暂停会阻断最终性能样本，因此必须等待全链路 Evidence 完成。

## 关机安全状态

- CloudFormation 服务端更新已完成。
- 本地 CloudFormation 轮询进程已在确认云端 `UPDATE_COMPLETE` 后安全中断。
- 没有需要保持运行的本地终端任务。
