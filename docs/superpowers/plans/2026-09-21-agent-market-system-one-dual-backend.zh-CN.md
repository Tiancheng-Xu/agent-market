# Agent Market System-One 双后端实施计划

> **给代理工作者：** 必须使用子技能：用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐项实施本计划。各步骤使用复选框（`- [ ]`）语法跟踪。

**目标：** 增加由本地 Laya 和托管式 Jev 组成的双影子决策平面，在记录脱敏对照证据的同时，保持现有 Agent Market 确定性工作流的最终决策权。

**架构：** 把当前 Jev 结果抽象为与提供方无关的接口，在注入式懒加载会话之后实现 Laya，并在一个始终返回确定性基线的协调器中比较两个提供方。只有当 `SYSTEM_ONE_SHADOW_MODE=dual-shadow` 时，本地运行时才能预加载经过哈希固定的 ONNX 包；关闭模式不导入任何模型，也不需要任何提供方凭据。

**技术栈：** Node.js 22、TypeScript 7、Zod 4、Vitest 4、`@receptron/laya@0.1.1`、ONNX Runtime、原生 `crypto`/`fs`。

**规格：** `docs/superpowers/specs/2026-09-21-agent-market-system-one-dual-backend/design.md`

## 全局约束

- 确定性宿主始终对资格、排序、分数、争议、洗牌、权限、资金、钱包、合约和结算拥有最终决策权。
- 本阶段只支持 `off` 和 `dual-shadow`；不得定义 `laya-primary` 或 `jev-primary`。
- Laya 模型修订版为 `68f27dfe5a27a54fb2b1fefc432f43f972e90868`；计算图 SHA-256 为 `a874eb254b58b0fcb1e7ad56fbb188c29d64e08c9a46b689433e1f52c66dba1e`；数据 SHA-256 为 `487746363a8da57bcadb4345352997d22a0fb90d70aa22c6856668d023242aba`。
- Laya 权重必须留在 Git 之外，任务执行或启动期间绝不能下载。
- `TYPESAFE_API_KEY` 必须继续作为服务端机密输入，绝不能进入文件、浏览器代码、日志、fixture 或 Evidence。
- 提供方输入只能包含不透明引用、HMAC、分桶状态、原因代码和宿主允许的选项。
- 不创建或更改任何 AWS、Cloudflare、数据库、链、付费共享资源、Clash 设置或系统代理。
- 所有实现和验证都在 Node `>=22 <23` 下运行；仓库 lockfile 只能因固定版本的 Laya 依赖而变更。

## 审查重点

- `3.97` 这类小数 `score` 输出必须保留小数；验证它的五标签分布时，不得把分数伪装成已选标签。
- `off` 模式不得导入 ONNX Runtime、读取模型文件状态、加载 1.6 GiB 权重或要求 Jev 密钥。
- Laya 选择了候选池或路由池之外的选项时，必须像 Jev 一样安全失败。
- 超时不会取消 ONNX 计算；必须忽略迟到的提供方结果，且绝不能重复写入 Evidence。
- 双影子提供方发生分歧或故障时，必须保留确定性基线，并且只能发出经过脱敏、范围受限的元数据。

---

### 任务 1：接受真实的小数 System-One 分数

**文件：**
- 修改：`apps/local-agent-runner/src/jev-decision-adapter.test.ts`
- 修改：`apps/local-agent-runner/src/jev-decision-adapter.ts`

**接口：**
- 输入：线上 Jev `score` 响应，其中期望值位于 `[0, 4]`，概率键为 `"0"` 到 `"4"`。
- 输出：观测结果的 `value` 保留小数形式的期望分数。

- [ ] **步骤 1：为观测到的线上响应形状增加一个失败的回归测试**

增加使用以下内容的案例：

```ts
jevResponse({
  quality: {
    type: "score",
    score: 3.97,
    confidence: 0.98,
    probabilities: { "0": 0, "1": 0, "2": 0, "3": 0.02, "4": 0.98 },
    legend: { "0": "unusable", "1": "poor", "2": "mixed", "3": "good", "4": "excellent" },
  },
})
```

断言 `scoreQuality(qualityDecision)` 返回 `status: "observed"` 和 `value: 3.97`。再增加一个概率之和为 `0.7` 的响应，并断言结果为 `invalid_response`。

- [ ] **步骤 2：运行目标测试并确认 RED**

运行：

```bash
pnpm --filter @agent-market/local-agent-runner exec vitest run src/jev-decision-adapter.test.ts
```

预期：小数分数测试失败，因为当前 `ScoreAnswerSchema` 要求整数。

- [ ] **步骤 3：拆分 Choice 与 Score 的分布验证**

把分数 schema 改为 `z.number().min(0).max(4)`。为 choice 输出保留 `hasValidChoiceDistribution(probabilities, allowedKeys, selectedKey)`。增加：

```ts
function hasValidScoreDistribution(probabilities: Record<string, number>): boolean {
  const expected = new Set(["0", "1", "2", "3", "4"]);
  const entries = Object.entries(probabilities);
  if (entries.length !== expected.size || entries.some(([key]) => !expected.has(key))) return false;
  return Math.abs(entries.reduce((sum, [, value]) => sum + value, 0) - 1) <= 0.01;
}
```

不得对返回分数取整，也不得要求 `String(score)` 是概率键。

- [ ] **步骤 4：确认 GREEN，并验证整个包**

先运行目标测试，再运行：

```bash
pnpm --filter @agent-market/local-agent-runner test
pnpm --filter @agent-market/local-agent-runner typecheck
```

预期：所有测试和类型检查都在 Node 22 下通过。

- [ ] **步骤 5：提交回归修复**

```bash
git add apps/local-agent-runner/src/jev-decision-adapter.ts apps/local-agent-runner/src/jev-decision-adapter.test.ts
git commit -m "fix: accept fractional system-one scores"
```

### 任务 2：引入与提供方无关的决策契约

**文件：**
- 新建：`apps/local-agent-runner/src/system-one-decision-provider.ts`
- 新建：`apps/local-agent-runner/src/system-one-decision-provider.test.ts`
- 修改：`apps/local-agent-runner/src/jev-decision-adapter.ts`
- 修改：`apps/local-agent-runner/src/jev-decision-adapter.test.ts`
- 修改：`apps/local-agent-runner/src/index.ts`

**接口：**
- 输入：来自 `@agent-market/shared-contracts` 的现有匹配、质量、争议、阈值和回退契约。
- 输出：供两个适配器和协调器使用的 `SystemOneDecisionProvider`、`SystemOneDecisionResult` 以及与提供方无关的验证辅助函数。

- [ ] **步骤 1：编写失败的提供方契约测试**

在测试中定义期望的形状：

```ts
const observed: SystemOneDecisionResult = {
  status: "observed",
  provider: "laya",
  decisionType: "agent_quality",
  decisionId: "quality_01",
  value: 3.183,
  confidence: 0.369,
  probabilities: { "0": 0.0247, "1": 0.0395, "2": 0.0272, "3": 0.5453, "4": 0.3633 },
  margin: 0.182,
  model: "laya@68f27dfe",
  usage: { inputTokens: 109 },
  latencyMs: 99,
};
```

断言 `validateChoiceAnswer` 拒绝候选池外的键，`validateScoreAnswer` 接受小数形式的期望分数，并且 `probabilityMargin` 返回最高两项之差。

- [ ] **步骤 2：确认 RED，因为模块尚不存在**

运行：

```bash
pnpm --filter @agent-market/local-agent-runner exec vitest run src/system-one-decision-provider.test.ts
```

预期：module-not-found 失败。

- [ ] **步骤 3：实现最小的提供方无关模块**

导出：

```ts
export type SystemOneProviderName = "laya" | "jev";
export type SystemOneDecisionResult =
  | { status: "fallback"; provider: SystemOneProviderName; decisionType: JevDecisionType; decisionId: string; reason: JevFallbackReason }
  | { status: "observed"; provider: SystemOneProviderName; decisionType: JevDecisionType; decisionId: string; value: string | number; confidence: number; probabilities: Record<string, number>; margin: number; model: string; usage: { inputTokens: number; outputTokens?: number }; latencyMs: number };

export type SystemOneDecisionProvider = {
  provider: SystemOneProviderName;
  match(decision: AgentMatchDecisionV1): Promise<SystemOneDecisionResult>;
  scoreQuality(decision: AgentQualityDecisionV1): Promise<SystemOneDecisionResult>;
  routeDispute(decision: DisputeRouteDecisionV1): Promise<SystemOneDecisionResult>;
  close?(): Promise<void>;
};
```

把共用概率函数移入这个模块。它们必须是纯函数，不得了解 HTTP 或 ONNX。

- [ ] **步骤 4：在不改变行为的情况下适配 Jev**

让 `createJevDecisionAdapter` 返回 `SystemOneDecisionProvider`；为观测和回退结果增加 `provider: "jev"`。暂时保留现有导出的 Jev 别名，确保目标工作树的集成仍便于审查。

- [ ] **步骤 5：运行提供方和 Jev 测试，再运行包测试／类型检查**

预期：全部通过，而且没有 snapshot 或 fixture 包含凭据。

- [ ] **步骤 6：提交契约抽取**

```bash
git add apps/local-agent-runner/src/system-one-decision-provider.ts apps/local-agent-runner/src/system-one-decision-provider.test.ts apps/local-agent-runner/src/jev-decision-adapter.ts apps/local-agent-runner/src/jev-decision-adapter.test.ts apps/local-agent-runner/src/index.ts
git commit -m "refactor: extract system-one provider contract"
```

### 任务 3：增加经过哈希固定的本地 Laya 提供方

**文件：**
- 修改：`apps/local-agent-runner/package.json`
- 修改：`pnpm-lock.yaml`
- 修改：`pnpm-workspace.yaml`
- 新建：`apps/local-agent-runner/src/laya-decision-adapter.ts`
- 新建：`apps/local-agent-runner/src/laya-decision-adapter.test.ts`
- 修改：`apps/local-agent-runner/src/index.ts`

**接口：**
- 输入：`SystemOneDecisionProvider`、本地模型目录、固定的修订版和哈希、策略、超时，以及注入的 `loadSession` 函数。
- 输出：带有懒加载 `match`、`scoreQuality`、`routeDispute`、就绪状态和关闭行为的 `createLayaDecisionAdapter(config)`。

- [ ] **步骤 1：使用内存中的伪 Laya 会话增加失败测试**

伪会话只实现：

```ts
type LayaSession = {
  systemOne(state: unknown, questions: Record<string, unknown>): Promise<{
    answers: Record<string, unknown>;
    usage?: { input_tokens?: number };
  }>;
  close(): Promise<void>;
};
```

测试必须证明：

- 关闭模式既不调用 `fs`，也不调用 `loadSession`；
- 第一次启用后的调用会验证两个模型哈希，并且只加载一次；
- 后续调用复用同一个会话；
- choice、小数 score 和 dispute 答案能被正确标准化；
- 低置信度、格式错误的分布、候选池外选项、加载失败和超时都会回退；
- `close()` 只关闭已加载的会话，并且是幂等的。

- [ ] **步骤 2：确认 RED，因为 Laya 适配器尚不存在**

运行新测试文件，观察 module-not-found。

- [ ] **步骤 3：增加固定版本的运行时依赖**

在 local-agent-runner 依赖中增加 `"@receptron/laya": "0.1.1"`，并在 `pnpm-workspace.yaml` 的 `allowBuilds` 中增加 `onnxruntime-node: true`。先运行 `pnpm install --lockfile-only`，并审查 lockfile 是否只增加了 Laya 运行时依赖树。

- [ ] **步骤 4：实现懒加载和哈希验证**

对两个大文件使用 `createReadStream` 加 `createHash("sha256")`，使启动过程不会把 1.6 GiB 全部加载进内存。只有哈希通过后，默认加载器才使用动态导入：

```ts
const { Laya } = await import("@receptron/laya");
return Laya.load({ modelDir, executionProviders: ["cpu"] });
```

适配器绝不能把仓库、修订版、token 或缓存目录传给 `Laya.load`；这样可以阻止运行时下载。

- [ ] **步骤 5：基于相同的脱敏决策形状实现提供方方法**

复用 Jev 的问题文本和标准。用共用的提供方辅助函数验证输出，并应用相同阈值策略。模型表示为 `laya@${revision}`；提供用量时表示为 `{ inputTokens }`。

- [ ] **步骤 6：验证适配器和依赖边界**

运行 local-agent-runner 的测试／类型检查、`pnpm install --offline --frozen-lockfile`，并搜索仓库，证明没有模型二进制文件或本地模型路径被跟踪。

- [ ] **步骤 7：提交 Laya 提供方**

```bash
git add apps/local-agent-runner/package.json pnpm-lock.yaml pnpm-workspace.yaml apps/local-agent-runner/src/laya-decision-adapter.ts apps/local-agent-runner/src/laya-decision-adapter.test.ts apps/local-agent-runner/src/index.ts
git commit -m "feat: add hash-pinned local Laya provider"
```

### 任务 4：解析安全失败的双影子配置

**文件：**
- 修改：`apps/local-agent-runner/src/config.ts`
- 修改：`apps/local-agent-runner/src/jev-decision-adapter.test.ts`
- 新建：`apps/local-agent-runner/src/system-one-shadow-config.test.ts`
- 修改：`apps/local-agent-runner/src/index.ts`

**接口：**
- 输入：本地运行时环境变量。
- 输出：`parseSystemOneShadowConfig(env): SystemOneShadowConfig`，其值为带判别字段的 `off` 配置或完整的 `dual-shadow` 配置。

- [ ] **步骤 1：编写失败的配置测试**

固定以下结果：

```ts
expect(parseSystemOneShadowConfig({})).toEqual({ mode: "off" });
```

对 `dual-shadow`，要求 `LAYA_MODEL_DIR` 是绝对路径、使用精确的固定修订版、`LAYA_TIMEOUT_MS` 是 100–10,000 范围内的整数，并且单独解析可选 Jev 配置。拒绝未知模式、相对路径、错误修订版和超出范围的超时。

- [ ] **步骤 2：确认 RED，然后实现带判别字段的解析器**

关闭模式必须在读取或验证任何 Laya/Jev 字段之前返回。应用代码不得读取 Keychain。

- [ ] **步骤 3：运行配置测试、包测试和类型检查**

- [ ] **步骤 4：提交配置支持**

```bash
git add apps/local-agent-runner/src/config.ts apps/local-agent-runner/src/jev-decision-adapter.test.ts apps/local-agent-runner/src/system-one-shadow-config.test.ts apps/local-agent-runner/src/index.ts
git commit -m "feat: add fail-closed system-one shadow config"
```

### 任务 5：比较两个提供方，同时不改变确定性决策

**文件：**
- 新建：`apps/local-agent-runner/src/system-one-shadow-coordinator.ts`
- 新建：`apps/local-agent-runner/src/system-one-shadow-coordinator.test.ts`
- 修改：`apps/local-agent-runner/src/queen-orchestrator.ts`
- 修改：`apps/local-agent-runner/src/queen-orchestrator.test.ts`
- 修改：`apps/local-agent-runner/src/index.ts`

**接口：**
- 输入：确定性基线值、脱敏后的决策对象、零到两个提供方，以及一个注入式且范围受限的 Evidence sink。
- 输出：`observeMatch`、`observeQuality` 和 `observeDispute`；每个方法都在完成可选影子观测后，原样返回传入的基线。

- [ ] **步骤 1：编写失败的协调器测试**

对每一种决策类型，断言返回的基线具有严格对象同一性或深度相等。覆盖提供方一致、分歧、回退、超时、抛错、迟到完成，以及 Evidence sink 抛错的情况。宿主结果在所有情况下都必须保持不变。

Evidence 记录只包含：

```ts
{
  schemaVersion: 1,
  decisionType,
  decisionId,
  baselineResultHash,
  observations: [{ provider, status, model, resultHash, confidence, margin, latencyMs, fallbackReason }],
  agreement: "all" | "partial" | "none" | "insufficient",
}
```

不得写入原始决策或基线值。

- [ ] **步骤 2：确认 RED，然后实现有界的并发观测**

对已经由适配器超时限制的提供方调用使用 `Promise.allSettled`。用 SHA-256 哈希标准化值。只调用一次 sink；吞掉 sink 故障，只通过注入的诊断回调暴露。绝不重试提供方。

- [ ] **步骤 3：增加显式的 Queen 注入点**

在 `QueenOrchestratorOptions` 中增加可选的 `systemOneShadow`。把相关内部处理器改为异步；在确定性结果已经固定之后，等待有界的影子观测，然后原样返回该结果。完成确定性排序后，使用不透明候选引用调用 `observeMatch`。确定 Judge 结果后，调用 `observeQuality`／`observeDispute`，但不得改变 `recordScore`、图边、任务分配或 GraphQL 响应。适配器超时限制了额外的影子延迟；关闭模式不增加异步工作。

测试必须断言：无论影子模式启用还是关闭，自动选择的仍是同一个候选人、写入的是同一个分数事件、返回的是同一个争议分支。

- [ ] **步骤 4：运行 Queen 测试、local-agent-runner 测试和类型检查**

- [ ] **步骤 5：提交零权限集成**

```bash
git add apps/local-agent-runner/src/system-one-shadow-coordinator.ts apps/local-agent-runner/src/system-one-shadow-coordinator.test.ts apps/local-agent-runner/src/queen-orchestrator.ts apps/local-agent-runner/src/queen-orchestrator.test.ts apps/local-agent-runner/src/index.ts
git commit -m "feat: observe system-one decisions without authority"
```

### 任务 6：连接本地运行时生命周期并产出可复现的 Evidence

**文件：**
- 修改：`apps/local-agent-runner/src/runtime-server.ts`
- 新建：`apps/local-agent-runner/src/system-one-runtime.ts`
- 新建：`apps/local-agent-runner/src/system-one-runtime.test.ts`
- 新建：`apps/local-agent-runner/evaluation/system-one-dual-shadow-cases.json`
- 新建：`apps/local-agent-runner/src/system-one-dual-shadow-evidence.test.ts`
- 新建：`docs/evidence/testing/2026-09-21-system-one-dual-shadow-eval.json`

**接口：**
- 输入：解析后的配置、Laya/Jev 工厂、现有合成决策案例和 Evidence writer。
- 输出：关闭模式的空操作，或一个可关闭的双影子运行时，以及生成的合成评估产物。

- [ ] **步骤 1：编写失败的生命周期测试**

断言关闭模式不创建任何提供方。双影子模式只创建一次 Laya；只有在显式启用且提供密钥时才创建 Jev；并且通过一条幂等关闭路径，在 `SIGINT` 和 `SIGTERM` 时关闭已加载的提供方。

- [ ] **步骤 2：实现运行时组合**

让 Keychain 留在仓库代码之外：运行时只能从环境变量接收 `TYPESAFE_API_KEY`。就绪日志只记录提供方名称以及就绪／回退状态——绝不记录模型路径、密钥、原始输入或完整输出。

- [ ] **步骤 3：增加冻结的合成对照案例**

至少包含：明确匹配、模糊匹配、小数质量分数、格式错误的分数分布、高风险争议、候选池外选项、模型缺失、密钥缺失、提供方分歧和超时。fixture 使用注入的传输层／会话；测试不发起任何真实网络请求。

- [ ] **步骤 4：根据实际执行的案例生成 Evidence**

测试从执行结果派生数量、一致情况、回退原因、违规情况以及伪传输层的实际调用次数。它断言 `realTypeSafeRequests: 0`、`hardFilterViolations: 0`、`authorityMutations: 0`，并确认已提交 JSON 与生成对象完全相等。

- [ ] **步骤 5：运行完整的 Node 22 门禁**

运行：

```bash
pnpm --filter @agent-market/shared-contracts test
pnpm --filter @agent-market/local-agent-runner test
pnpm --filter @agent-market/shared-contracts typecheck
pnpm --filter @agent-market/local-agent-runner typecheck
node scripts/validate-repository.mjs
git diff --check
```

还要针对已经通过哈希验证的模型包运行离线本地冒烟测试。发布门禁期间不得调用 Jev；较早的三案例 API 探测仍只是可行性证据，而不是可重复测试。

- [ ] **步骤 6：提交运行时和 Evidence**

```bash
git add apps/local-agent-runner/src/runtime-server.ts apps/local-agent-runner/src/system-one-runtime.ts apps/local-agent-runner/src/system-one-runtime.test.ts apps/local-agent-runner/evaluation/system-one-dual-shadow-cases.json apps/local-agent-runner/src/system-one-dual-shadow-evidence.test.ts docs/evidence/testing/2026-09-21-system-one-dual-shadow-eval.json
git commit -m "feat: wire local dual-shadow lifecycle"
```

### 任务 7：审查、精确集成交接与本地生产激活

**文件：**
- 仅在审查要求时修改：任务 1–6 中变更的文件。
- 不修改：除非脏目标工作树的所有者接受按文件集成的顺序，否则不得修改该工作树。

**接口：**
- 输入：已完成的隔离分支、Node 22 验证输出和脏目标工作树状态。
- 输出：经过审查的提交序列、精确集成顺序、熔断开关命令以及真实的激活状态。

- [ ] **步骤 1：依据设计和权限边界审查分支**

任何让提供方输出改变排序、分数存储、争议状态转换、洗牌、权限、资金、钱包或链上状态的路径都必须拒绝。

- [ ] **步骤 2：从干净的隔离工作树重新运行完整验证门禁**

记录测试数量、Node 版本、模型修订版／哈希和 `git status --short`。不得调用 TypeSafe，也不得暴露 Keychain 中的值。

- [ ] **步骤 3：为脏的所有者工作树给出按文件集成的顺序**

由于 `packages/shared-contracts/src/index.ts`、Queen 文件、配置、运行时、文档和 lockfile 可能重叠，不得合并整个分支。按任务顺序应用提交，逐一审慎解决每个重叠的导出或运行时组合，并在每个提交之后重新运行受影响的测试。

- [ ] **步骤 4：集成后只激活本地 `dual-shadow`**

使用固定的外部模型目录和 `SYSTEM_ONE_SHADOW_MODE=dual-shadow` 启动本地 Runner。除非明确保留了脱敏远程对照门禁，否则 Jev 对照保持关闭。验证就绪状态和一次合成本地观测；回滚时把 `SYSTEM_ONE_SHADOW_MODE=off` 并重启。

- [ ] **步骤 5：在云端发布或权限晋级之前停止**

本计划不得部署 AWS/Cloudflare、推送生产发布或授予提供方权限。这些操作需要带标签的评估和一次独立的生产发布决策。
