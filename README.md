# Agent Market

Agent Market is a bilingual, evidence-first course project for verifiable agent work. The repository separates implementation, local verification, and external production proof; UI state alone is never completion evidence.

Agent Market 是一个中英双语、证据优先的可验证智能体协作课程项目。仓库严格区分实现、本地验证和外部生产证据，界面展示本身不代表交付完成。

## Delivery truth / 交付事实

### V1 verified production / V1 已验证生产状态

- Cloudflare Edge SSR route readback is recorded for `/evidence`, a deep task route, and a real HTTP 404.
- The AWS performance path has project-owned evidence for API Gateway, Lambda, SNS, SQS/DLQ, ECS Fargate exit `0`, PostgreSQL readback, public Evidence readback, and reversible pause.
- Existing sanitized screenshots in `apps/web/public/evidence/` are V1 evidence, not V2 deployment proof.
- Cloudflare Edge SSR 已完成 `/evidence`、任务深层路由和真实 HTTP 404 回读。
- AWS 性能链路已有项目归属证据，覆盖 API Gateway、Lambda、SNS、SQS/DLQ、ECS Fargate 退出码 `0`、PostgreSQL 回读、公开 Evidence 回读和可逆暂停。
- `apps/web/public/evidence/` 中的脱敏截图仅证明 V1，不作为 V2 部署证据。

### V2 local and pending / V2 本地与待外部验证

- Local code and tests cover Web SSR/hydration/CSR recovery, wallet challenge-sign-verify with HttpOnly session handling, server-derived unsigned intents, contracts, Go matcher, grouped OOF/CV trainer, safe JSON artifacts, and non-deploy CI gates.
- V2 Sepolia deployment and transaction/event readback are `pending-external`.
- V2 AWS and Cloudflare deployments are `pending-external`.
- Real PostgreSQL/pgvector integration remains pending where the local gate reports a skipped database test.
- The Graph is `deferred`; Phase 2 uses exact RPC receipt/log verification plus Blockscout reconciliation.
- 本地代码与测试覆盖 Web SSR/hydration/CSR 恢复、钱包 challenge-sign-verify 与 HttpOnly session、服务端生成 unsigned intent、合约、Go matcher、grouped OOF/CV trainer、安全 JSON artifact 和无部署 CI 门禁。
- V2 Sepolia 部署及交易/事件回读为 `pending-external`。
- V2 AWS 与 Cloudflare 部署为 `pending-external`。
- 本地数据库 Gate 跳过时，真实 PostgreSQL/pgvector integration 仍是待验证状态。
- The Graph 状态为 `deferred`；二期先使用 RPC 精确回执/日志校验与 Blockscout 对账。

See `docs/architecture/adr/0001-defer-the-graph.md` for the indexer decision.

## Local verification / 本地验证

```bash
pnpm install --frozen-lockfile
pnpm verify
pnpm --dir apps/web build
```

Canonical status is recorded in `docs/evidence/requirements.yaml` and `docs/evidence/phase2-local-validation.json`.

权威状态记录在 `docs/evidence/requirements.yaml` 与 `docs/evidence/phase2-local-validation.json`。
