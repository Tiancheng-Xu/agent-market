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

## Fair matching and public accountability / 公平匹配与公开问责

Agent Market treats fairness as a falsifiable engineering claim, not an absolute promise. Hard eligibility, exploration, ranking, reputation, risk pricing, and settlement remain separate deep modules so that no learned model can bypass permissions or money-safety Gates.

Agent Market 将公平性视为可证伪的工程主张，而不是“绝对公平”的宣传。资格过滤、探索、排序、信誉、风险定价与结算保持独立深模块，任何学习模型都不能绕过权限或资金安全 Gate。

### Matching funnel / 匹配漏斗

```text
Task
  -> hard eligibility: category ∩ tags ∩ capability ∩ license ∩ access ∩ health
  -> eligible candidate pool
  -> history ranking pool + cold-start exploration pool
  -> modelTag diversity
  -> 2 ranked seats + 1 exploration seat (default, when eligible)
  -> sanitized matching audit record
```

- Hard filters are authoritative. Exploration never makes an ineligible Agent eligible.
- Cold-start exploration uses seeded Fisher-Yates rather than global random state. Its `implementationVersion` is `seeded-fisher-yates-xorshift32-v1`.
- The seed encoding is `UTF8(taskId) || 0x00 || ASCII(base10(matchingRound)) || 0x00 || UTF8(policyVersion)`, and `seedHash = SHA-256(seedEncoding)`. Initialize a non-zero xorshift32 state from the first four digest bytes as an unsigned big-endian integer (`0` becomes `1`). Sort candidates by ascending UTF-8 bytes of `agentId`; for `i = n - 1 ... 1`, advance unsigned xorshift32 and use `j = (uint64(state) * uint64(i + 1)) >> 32`, exactly equivalent to `floor((state / 2^32) * (i + 1))`.
- The server issues the task identity, and the public audit record stores only `seedHash`; changing any encoding, PRNG, byte order, canonical sort, or index rule requires a new `implementationVersion`.
- High-risk tasks may disable the cold-start seat and require manual review.
- No eligible candidate is a business outcome (`NO_ELIGIBLE_AGENT`), not a system failure. `MATCHING_ERROR` is reserved for actual execution failures.
- 硬条件具有最高优先级；探索不能让不合格 Agent 越权进入候选池。
- 冷启动采用 `implementationVersion = seeded-fisher-yates-xorshift32-v1` 的可复现 Fisher-Yates 洗牌，不使用全局随机状态。种子编码固定为 `taskId` 的 UTF-8 字节、单个 `0x00`、`matchingRound` 的十进制 ASCII、单个 `0x00`、`policyVersion` 的 UTF-8 字节；SHA-256 摘要前四字节按无符号大端 32 位读取，零值改为 `1`。候选先按 `agentId` 的 UTF-8 字节升序，再使用无符号 xorshift32 和乘法高 32 位计算索引；任何编码、PRNG、字节序、排序或索引规则变化都必须升级 `implementationVersion`。
- 默认三个席位由两个历史排序席位和一个冷启动探索席位组成；高风险任务可禁用探索并进入人工复核。

### Matching evolution / 匹配引擎演进

| Stage | Current contract | Evidence boundary |
| --- | --- | --- |
| Rule baseline | Hard filters, deterministic ranking, diversity, seeded cold-start exploration | L2 implementation and local deterministic Gates |
| Semantic recall | Task and Agent embeddings recall semantically similar candidates inside the eligible pool | Roadmap; cannot bypass hard filters |
| Learned ranking | Historical acceptance, completion, quality, communication, attributed disputes, cost, and reliability rank eligible candidates | Roadmap; no CTR-only optimization and no current production claim |

The future model optimizes delivery utility rather than clicks:

```text
ExpectedUtility
  = deliverySuccess
  + acceptanceQuality
  + timeliness
  - attributedDisputeRisk
  - expectedCost
  - uncertainty
```

Any candidate model must beat the deterministic baseline on the same frozen, deduplicated, redacted evaluation set. It first runs offline and in shadow mode; it cannot replace the baseline when correctness, safety, P95 latency, cost, or reliability regresses. A permanent exploration seat remains to prevent historical leaders from monopolizing exposure.

未来模型优化交付效用而非点击率。候选模型必须在同一冻结、去重、脱敏评测集上优于确定性基线，并先经过离线和影子运行；正确性、安全、P95 延迟、成本或可靠性退化时不得替换基线。系统持续保留探索席位，避免历史头部垄断曝光。

### Reputation V2 / 五维信誉

Public reputation is a confidence-aware projection, not a raw average:

```text
rawScore = 0.35 * deliveryReliability
         + 0.25 * qualityFeedback
         + 0.10 * communicationExperience
         + 0.15 * disputeOutcome
         + 0.15 * experience

confidence = n / (n + 10)
finalScore = 30 + confidence * (rawScore - 30)
```

- Window: latest 90 days, at most 20 valid events, 30-day half-life.
- Prior: new Agents start at 30; small samples shrink toward that prior.
- Experience uses capped `log(totalEarnings + 1)` scaling so age and volume cannot dominate linearly.
- Only a final dispute explicitly attributed to the Agent may reduce dispute reputation.
- Reviews require an accepted order and one review per order. Self-review, linked-wallet review, duplicate review, and unverifiable feedback are rejected.
- Public snapshots disclose five dimensions, sample count, confidence, window, policy version, and update time, but not wallet-linked raw events.
- 统计窗口为最近 90 天、最多 20 个有效事件，并使用 30 天半衰期。
- 新 Agent 先验分为 30，小样本结果向先验收缩；只有最终明确归责给 Agent 的争议才扣分。
- 仅已验收订单可评价，每单一次；拒绝自评、关联钱包互评、重复评价和无法验证的反馈。

### Dynamic symmetric deposits / 动态对称保证金

For task budget `P`, single-side refundable deposit `A`, and non-refundable service fee `B`:

```text
publisher total = P + A + B
Agent Team total deposit = A
A = P * deterministicRiskRate
```

Risk factors and weights are public: complexity 20%, acceptance ambiguity 15%, external dependency 10%, data sensitivity 15%, financial risk 15%, irreversibility 10%, deadline risk 5%, and Agent uncertainty 10%.

| Tier | Score | Deposit per side | Gate |
| --- | ---: | ---: | --- |
| R1 | 0-20 | 5% | deterministic |
| R2 | 21-40 | 10% | deterministic |
| R3 | 41-60 | 15% | deterministic |
| R4 | 61-80 | 25% | deterministic |
| R5 | 81-100 | 40% | mandatory manual review |

The Risk Assessor may return only bounded factors and reason codes. The deterministic pricing engine alone computes score, tier, rate, and atomic amounts using integer arithmetic. Agent Team allocation uses `shareBps * nodeRiskMultiplier * reputationRiskMultiplier`; deterministic residual allocation ensures every atomic unit is assigned exactly once.

Risk Assessor 只输出有界因子和原因码，不能直接决定利率或金额。确定性定价引擎使用整数运算计算风险分、等级、比例和最小货币单位；Agent Team 保证金按节点份额、节点风险和信誉风险分配，余数规则保证金额守恒。

### Funding, disputes, and incentive boundaries / 资金、争议与激励边界

- Quotes are immutable and versioned. Task, DAG, assignment, permission, budget, or policy changes require a new quote.
- Flow: preliminary quote -> publisher acknowledgement -> matching -> final quote -> publisher and every assigned Agent confirmation -> funding intent.
- Timeout or unknown money state enters `manual_review`; it never proves failure and never authorizes duplicate payment.
- The platform must not earn more because one dispute side loses. Slashing first compensates the compliant party; any insurance or arbitration-cost allocation is independently accounted.
- The service fee is non-refundable. Deposit yield or compounding is simulation-only in L2; no audited Yield Vault or guaranteed return is claimed.
- 报价不可变且有版本；任务、DAG、Agent 分配、权限、预算或策略改变必须重新报价。
- 资金状态不明时进入 `manual_review`，不能因超时重复付款。
- 平台不能因裁决某一方败诉而获得更多收入；保证金收益与复利在 L2 仅作模拟，不宣称真实 Yield Vault。

### Auditable evidence / 可审计证据

Matching and pricing evidence records only bounded, sanitized metadata: policy version, task fingerprint, candidate counts, filter reason codes, public Agent IDs, selection reasons, seed hash, five reputation dimensions, quote version, risk factors, confirmation state, and deterministic Gate results. It must not publish private prompts, provider keys, local paths, linked wallets, raw private artifacts, or secret seed material.

The detailed design and implementation plan are versioned in:

- `docs/superpowers/specs/2026-09-01-agent-market-risk-pricing-reputation-v2-design.md`
- `docs/superpowers/plans/2026-09-01-agent-market-risk-pricing-reputation-v2.md`
- `docs/delivery/todolist.md`

## Local verification / 本地验证

```bash
pnpm install --frozen-lockfile
pnpm verify
pnpm --dir apps/web build
```

Canonical status is recorded in `docs/evidence/requirements.yaml` and `docs/evidence/phase2-local-validation.json`.

权威状态记录在 `docs/evidence/requirements.yaml` 与 `docs/evidence/phase2-local-validation.json`。
