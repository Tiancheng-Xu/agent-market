# Agent Market Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 Agent Market 一期可独立构建、测试和审查的非 UI 工程骨架，并冻结跨 TypeScript、Go、Python、Solidity 和异步消息的共享契约。

**Architecture:** pnpm monorepo 管理 TypeScript 与 Solidity workspace，Go matcher 和 Python trainer 保持原生工具链。A1 只提供最小健康端点、契约解析、确定性 matcher 基线、训练输入输出协议、合约测试基线和 Evidence 验证器，不创建 AWS、Cloudflare 或 Sepolia 资源。

**Tech Stack:** Node.js 22、pnpm 11、TypeScript、Next.js、Zod、Go 1.26、Python 3.14、Hardhat、Solidity、Node test runner、Go test、pytest

**Spec:** `docs/architecture/agent-market-architecture.md`

## Global Constraints

- Ethereum 网络固定为 Sepolia，`chainId = 11155111`。
- 测试资产名称固定为 YD；模拟收益固定年化 6%，按秒线性累计并向下取整。
- 仲裁固定 3 个有效席位，2 票形成结果。
- 一个 UUIDv7 `request_id` 贯穿 HTTP、数据库、事件、训练与链上 `request_ref`。
- API Key 只允许后端加密存储，任何日志、fixture、错误响应和前端 DTO 不得含明文。
- 所有 Evidence 初始状态为 `NOT_STARTED`；计划、截图和代码存在均不能提升为 `VERIFIED`。
- A1 禁止创建或修改 AWS、Cloudflare、Sepolia 和生产资源。
- A1 禁止实现生产前端；`apps/web` 等 Stitch 逐图验收后单独规划。
- 使用 TDD；每个任务完成自己的失败测试、最小实现、通过测试和独立提交。
- 单文件接近 2000 行必须拆分；跨运行时契约以 fixture 和 schema 为唯一真相。

---

## File Map

```text
package.json                              # 根命令和运行时约束
pnpm-workspace.yaml                       # TypeScript/Solidity workspace
tsconfig.base.json                        # 共享 TypeScript 严格配置
.editorconfig                             # 跨语言基础格式
packages/shared-contracts/                # HTTP、事件、错误与 Evidence schema
apps/transaction-engine/                  # Next.js Lambda-compatible BFF 骨架
services/matcher-go/                      # Go 匹配消费者与确定性 baseline
services/trainer/                         # Python CTR 离线训练协议骨架
packages/contracts/                       # Hardhat 与 Solidity 测试基线
scripts/validate-repository.mjs           # 聚合仓库结构门禁
docs/evidence/requirements.yaml           # REQ-AM-01..15 诚实状态台账
docs/evidence/schema.json                 # Evidence 机器校验契约
.github/workflows/verify.yml              # PR 非部署验证
```

## Task 1: Workspace 与仓库结构门禁

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `.editorconfig`
- Create: `scripts/validate-repository.test.mjs`
- Create: `scripts/validate-repository.mjs`

**Interfaces:**
- Consumes: 本机 Node.js 22 与 pnpm 11。
- Produces: 根命令 `pnpm check`、`pnpm test`、`pnpm typecheck`、`pnpm build`；函数 `validateRepository(root): string[]`。

- [ ] **Step 1: 写失败的仓库结构测试**

```js
// scripts/validate-repository.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { validateRepository } from "./validate-repository.mjs";

test("requires every architecture runtime directory", () => {
  const violations = validateRepository(process.cwd());
  assert.deepEqual(violations, []);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test scripts/validate-repository.test.mjs`  
Expected: FAIL，提示 `validate-repository.mjs` 不存在。

- [ ] **Step 3: 创建 workspace 配置和最小验证器**

```json
{
  "name": "agent-market",
  "private": true,
  "packageManager": "pnpm@11.17.0",
  "engines": { "node": ">=22 <23", "pnpm": ">=11 <12" },
  "scripts": {
    "check": "node scripts/validate-repository.mjs && pnpm -r --if-present check",
    "test": "node --test scripts/*.test.mjs && pnpm -r --if-present test",
    "typecheck": "pnpm -r --if-present typecheck",
    "build": "pnpm -r --if-present build"
  }
}
```

```yaml
# pnpm-workspace.yaml
packages:
  - apps/*
  - packages/*
```

```js
// scripts/validate-repository.mjs
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_DIRECTORIES = [
  "apps/transaction-engine",
  "packages/shared-contracts",
  "packages/contracts",
  "services/matcher-go",
  "services/trainer",
  "docs/evidence",
];

export function validateRepository(root) {
  return REQUIRED_DIRECTORIES
    .filter((path) => !existsSync(resolve(root, path)))
    .map((path) => `required-directory-missing:${path}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const violations = validateRepository(process.cwd());
  if (violations.length) {
    console.error(violations.join("\n"));
    process.exitCode = 1;
  }
}
```

`tsconfig.base.json` 必须启用 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noImplicitOverride`；`.editorconfig` 使用 UTF-8、LF、末尾换行和 2 空格默认缩进，Go 文件使用 tab。

- [ ] **Step 4: 创建 File Map 中的空目录标记并运行测试**

Run: `node --test scripts/validate-repository.test.mjs`  
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json .editorconfig scripts apps packages services docs/evidence
git commit -m "chore: establish agent market workspace"
```

## Task 2: 共享 HTTP、事件与错误契约

**Files:**
- Create: `packages/shared-contracts/package.json`
- Create: `packages/shared-contracts/tsconfig.json`
- Create: `packages/shared-contracts/src/request-context.ts`
- Create: `packages/shared-contracts/src/events.ts`
- Create: `packages/shared-contracts/src/errors.ts`
- Create: `packages/shared-contracts/src/index.ts`
- Create: `packages/shared-contracts/src/contracts.test.ts`
- Create: `packages/shared-contracts/fixtures/match-requested.v1.json`

**Interfaces:**
- Consumes: UUIDv7 字符串、`match.requested.v1` JSON。
- Produces: `RequestContextSchema`、`MatchRequestedV1Schema`、`AppErrorSchema`、`MATCH_REQUESTED_V1`。

- [ ] **Step 1: 写失败的契约测试**

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AppErrorSchema, MatchRequestedV1Schema } from "./index";

describe("shared contracts", () => {
  it("accepts the canonical match event fixture", () => {
    const fixture = JSON.parse(readFileSync("fixtures/match-requested.v1.json", "utf8"));
    expect(MatchRequestedV1Schema.parse(fixture).type).toBe("match.requested.v1");
  });

  it("rejects internal error details", () => {
    expect(() => AppErrorSchema.parse({ code: "INTERNAL", message: "safe", stack: "secret" })).toThrow();
  });
});
```

- [ ] **Step 2: 安装精确依赖并确认测试失败**

Run: `pnpm --dir packages/shared-contracts add --save-exact zod && pnpm --dir packages/shared-contracts add -D --save-exact typescript vitest && pnpm --filter @agent-market/shared-contracts test`  
Expected: FAIL，schema 尚未导出。

- [ ] **Step 3: 实现最小契约**

```ts
import { z } from "zod";

export const RequestContextSchema = z.object({
  requestId: z.string().uuid(),
  actorId: z.string().min(1),
  idempotencyKey: z.string().min(8).max(128),
});

export const MATCH_REQUESTED_V1 = "match.requested.v1" as const;
export const MatchRequestedV1Schema = z.strictObject({
  eventId: z.string().uuid(),
  type: z.literal(MATCH_REQUESTED_V1),
  occurredAt: z.string().datetime(),
  requestId: z.string().uuid(),
  matchJobId: z.string().uuid(),
  taskId: z.string().uuid(),
  modelVersion: z.string().min(1),
});

export const AppErrorSchema = z.strictObject({
  code: z.enum(["VALIDATION_FAILED", "UNAUTHORIZED", "FORBIDDEN", "CONFLICT", "UNAVAILABLE", "INTERNAL"]),
  message: z.string().min(1).max(240),
  requestId: z.string().uuid().optional(),
  retryable: z.boolean().default(false),
});
```

Fixture 使用固定非生产 UUID，不包含钱包、Endpoint、API Key 或个人数据。

- [ ] **Step 4: 运行 package 测试与类型检查**

Run: `pnpm --filter @agent-market/shared-contracts test && pnpm --filter @agent-market/shared-contracts typecheck`  
Expected: 两个命令均 PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/shared-contracts pnpm-lock.yaml
git commit -m "feat: freeze shared runtime contracts"
```

## Task 3: Transaction Engine 健康端点与请求上下文

**Files:**
- Create: `apps/transaction-engine/package.json`
- Create: `apps/transaction-engine/next.config.ts`
- Create: `apps/transaction-engine/tsconfig.json`
- Create: `apps/transaction-engine/src/lib/request-context.ts`
- Create: `apps/transaction-engine/src/lib/request-context.test.ts`
- Create: `apps/transaction-engine/src/app/api/health/route.ts`
- Create: `apps/transaction-engine/src/app/api/health/route.test.ts`

**Interfaces:**
- Consumes: 可选 `x-request-id`；不可信外部 Header。
- Produces: `resolveRequestId(headers): string`；`GET /api/health -> {status:"ok", service:"transaction-engine", requestId}`。

- [ ] **Step 1: 写失败测试**

```ts
import { expect, it } from "vitest";
import { resolveRequestId } from "./request-context";

it("keeps a valid request id and replaces invalid input", () => {
  const valid = "018f3f50-7b2d-7cc1-98f5-9ab68e75a211";
  expect(resolveRequestId(new Headers({ "x-request-id": valid }))).toBe(valid);
  expect(resolveRequestId(new Headers({ "x-request-id": "not-a-uuid" }))).toMatch(/^[0-9a-f-]{36}$/);
});
```

健康端点测试必须断言 `Cache-Control: no-store`、响应 `x-request-id` 与 JSON 中 `requestId` 相同，且没有环境变量或堆栈字段。

- [ ] **Step 2: 安装依赖并确认失败**

Run: `pnpm --dir apps/transaction-engine add --save-exact next react react-dom uuid @agent-market/shared-contracts@workspace:* && pnpm --dir apps/transaction-engine add -D --save-exact typescript vitest @types/node @types/react && pnpm --filter @agent-market/transaction-engine test`  
Expected: FAIL，`resolveRequestId` 与 route 尚不存在。

- [ ] **Step 3: 实现请求 ID 和健康端点**

```ts
// src/lib/request-context.ts
import { validate as isUuid, v7 as uuidv7 } from "uuid";

export function resolveRequestId(headers: Headers): string {
  const candidate = headers.get("x-request-id");
  return candidate && isUuid(candidate) ? candidate : uuidv7();
}
```

```ts
// src/app/api/health/route.ts
import { resolveRequestId } from "../../../lib/request-context";

export async function GET(request: Request): Promise<Response> {
  const requestId = resolveRequestId(request.headers);
  return Response.json(
    { status: "ok", service: "transaction-engine", requestId },
    { headers: { "cache-control": "no-store", "x-request-id": requestId } },
  );
}
```

- [ ] **Step 4: 运行测试、类型检查与构建**

Run: `pnpm --filter @agent-market/transaction-engine test && pnpm --filter @agent-market/transaction-engine typecheck && pnpm --filter @agent-market/transaction-engine build`  
Expected: 全部 PASS；构建不需要 AWS 凭证。

- [ ] **Step 5: 提交**

```bash
git add apps/transaction-engine pnpm-lock.yaml
git commit -m "feat: add transaction engine request boundary"
```

## Task 4: Go Matcher 确定性基线

**Files:**
- Create: `services/matcher-go/go.mod`
- Create: `services/matcher-go/internal/contracts/events.go`
- Create: `services/matcher-go/internal/contracts/events_test.go`
- Create: `services/matcher-go/internal/ranking/rank.go`
- Create: `services/matcher-go/internal/ranking/rank_test.go`
- Create: `services/matcher-go/cmd/matcher/main.go`
- Copy fixture: `services/matcher-go/testdata/match-requested.v1.json`

**Interfaces:**
- Consumes: `match.requested.v1`；候选 `ID`、`RuleScore`、`CtrScore`、`IsNewcomer`、`Eligible`。
- Produces: `ranking.Select(candidates, 2, 1) []Candidate`，固定 2 个高分候选和最多 1 个合格新人。

- [ ] **Step 1: 写失败的排序测试**

```go
func TestSelectReturnsTwoTopAndOneNewcomer(t *testing.T) {
	candidates := []Candidate{
		{ID: "a", RuleScore: 0.9, CTRScore: 0.8, Eligible: true},
		{ID: "b", RuleScore: 0.8, CTRScore: 0.7, Eligible: true},
		{ID: "c", RuleScore: 0.7, CTRScore: 0.6, Eligible: true, IsNewcomer: true},
		{ID: "d", RuleScore: 1.0, CTRScore: 1.0, Eligible: false},
	}
	got := Select(candidates, 2, 1)
	if diff := cmp.Diff([]string{"a", "b", "c"}, ids(got)); diff != "" {
		t.Fatal(diff)
	}
}
```

- [ ] **Step 2: 初始化 Go module 并确认失败**

Run: `cd services/matcher-go && go mod init github.com/Tiancheng-Xu/agent-market/services/matcher-go && go get github.com/google/go-cmp/cmp && go test ./...`  
Expected: FAIL，`Candidate` 与 `Select` 未定义。

- [ ] **Step 3: 实现稳定排序**

```go
type Candidate struct {
	ID          string
	RuleScore   float64
	CTRScore    float64
	IsNewcomer bool
	Eligible    bool
}

func score(candidate Candidate) float64 {
	return candidate.RuleScore*0.7 + candidate.CTRScore*0.3
}
```

`Select` 必须先移除 `Eligible=false`，按组合分降序、ID 升序稳定打破同分；高分位不重复选择新人探索位。事件 decoder 使用 `json.Decoder.DisallowUnknownFields()`，拒绝空 `requestId`、`matchJobId` 和错误事件版本。

- [ ] **Step 4: 运行 Go 门禁**

Run: `cd services/matcher-go && gofmt -w . && go vet ./... && go test ./...`  
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add services/matcher-go
git commit -m "feat: add deterministic matcher baseline"
```

## Task 5: Solidity 合约测试基线

**Files:**
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/hardhat.config.ts`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/contracts/YDToken.sol`
- Create: `packages/contracts/test/YDToken.test.ts`

**Interfaces:**
- Consumes: Sepolia 配置只在后续部署阶段注入；A1 不读取私钥。
- Produces: test-only ERC-20 `YDToken`，`faucet()` 按钱包冷却并限制单次额度。

- [ ] **Step 1: 写失败的水龙头测试**

```ts
it("mints one quota and rejects an immediate second claim", async () => {
  const [user] = await ethers.getSigners();
  const token = await ethers.deployContract("YDToken");
  await token.waitForDeployment();
  await token.connect(user).faucet();
  expect(await token.balanceOf(user.address)).to.equal(ethers.parseEther("1000"));
  await expect(token.connect(user).faucet()).to.be.revertedWithCustomError(token, "FaucetCoolingDown");
});
```

- [ ] **Step 2: 安装依赖并确认失败**

Run: `pnpm --dir packages/contracts add --save-exact @openzeppelin/contracts && pnpm --dir packages/contracts add -D --save-exact hardhat @nomicfoundation/hardhat-toolbox typescript && pnpm --filter @agent-market/contracts test`  
Expected: FAIL，`YDToken` artifact 不存在。

- [ ] **Step 3: 实现最小 YDToken**

```solidity
contract YDToken is ERC20 {
    uint256 public constant FAUCET_AMOUNT = 1_000 ether;
    uint256 public constant FAUCET_COOLDOWN = 1 days;
    mapping(address => uint256) public nextClaimAt;
    error FaucetCoolingDown(uint256 availableAt);

    constructor() ERC20("YD Test Token", "YD") {}

    function faucet() external {
        uint256 availableAt = nextClaimAt[msg.sender];
        if (block.timestamp < availableAt) revert FaucetCoolingDown(availableAt);
        nextClaimAt[msg.sender] = block.timestamp + FAUCET_COOLDOWN;
        _mint(msg.sender, FAUCET_AMOUNT);
    }
}
```

- [ ] **Step 4: 运行合约测试和编译**

Run: `pnpm --filter @agent-market/contracts test && pnpm --filter @agent-market/contracts build`  
Expected: PASS；不得连接 Sepolia。

- [ ] **Step 5: 提交**

```bash
git add packages/contracts pnpm-lock.yaml
git commit -m "feat: establish YD contract baseline"
```

## Task 6: CTR Trainer 输入输出协议

**Files:**
- Create: `services/trainer/pyproject.toml`
- Create: `services/trainer/src/agent_market_trainer/contracts.py`
- Create: `services/trainer/src/agent_market_trainer/train.py`
- Create: `services/trainer/tests/test_train.py`
- Create: `services/trainer/fixtures/training-samples.jsonl`
- Create: `services/trainer/Dockerfile`

**Interfaces:**
- Consumes: JSONL `sample_id`、`request_id`、数值特征、二元 `selected` 标签。
- Produces: `model.json`，包含 `training_run_id`、`algorithm`、`feature_order`、`coefficients`、`sample_count`、`metrics`、`created_at`。

- [ ] **Step 1: 写失败的确定性训练测试**

```python
def test_train_emits_versioned_model_without_personal_data(tmp_path):
    output = tmp_path / "model.json"
    result = train_model(FIXTURE, output, training_run_id="run-test-001")
    assert result["algorithm"] == "logistic-regression"
    assert result["sample_count"] == 6
    assert "request_id" not in output.read_text()
    assert result["feature_order"] == ["capability_score", "reliability_score", "price_score"]
```

- [ ] **Step 2: 创建隔离环境并确认失败**

Run: `cd services/trainer && python3 -m venv .venv && .venv/bin/pip install -e '.[test]' && .venv/bin/pytest -q`  
Expected: FAIL，`train_model` 不存在。

- [ ] **Step 3: 实现最小训练函数**

使用 `scikit-learn` 的 `LogisticRegression(random_state=42, solver="liblinear")`。输入 schema 只允许三个数值特征和标签；训练前拒绝重复 `sample_id`、非有限值、单一标签数据集。输出 JSON 使用排序键和 UTC ISO 时间，不写原始样本、钱包、消息或 `request_id`。

Dockerfile 使用非 root 用户、固定工作目录、无 AWS 凭证层；入口为：

```dockerfile
ENTRYPOINT ["python", "-m", "agent_market_trainer.train"]
```

- [ ] **Step 4: 运行测试和本地容器构建**

Run: `cd services/trainer && .venv/bin/pytest -q && docker build -t agent-market-trainer:local .`  
Expected: 测试 PASS，镜像构建成功；不运行 ECS。

- [ ] **Step 5: 提交**

```bash
git add services/trainer
git commit -m "feat: define offline CTR training contract"
```

## Task 7: Evidence 诚实状态台账与验证器

**Files:**
- Create: `docs/evidence/schema.json`
- Create: `docs/evidence/requirements.yaml`
- Create: `scripts/validate-evidence.test.mjs`
- Create: `scripts/validate-evidence.mjs`

**Interfaces:**
- Consumes: REQ-AM-01..15 YAML 台账。
- Produces: `validateEvidence(document): string[]`；阻止缺项、重复 ID、非法状态和无证据的 `VERIFIED`。

- [ ] **Step 1: 写失败测试**

```js
test("rejects verified requirements without external evidence", () => {
  const violations = validateEvidence({
    requirements: [{
      requirement_id: "REQ-AM-01",
      status: "VERIFIED",
      implementation_locations: ["packages/contracts/contracts/YDToken.sol"],
      test_evidence: [],
      deployment_evidence: [],
      transaction_evidence: [],
      last_verified_at: null,
      blockers: [],
    }],
  });
  assert.ok(violations.includes("verified-without-test:REQ-AM-01"));
});
```

- [ ] **Step 2: 安装 YAML parser 并确认失败**

Run: `pnpm add -Dw --save-exact yaml && node --test scripts/validate-evidence.test.mjs`  
Expected: FAIL，验证器尚不存在。

- [ ] **Step 3: 实现状态规则并初始化 15 项**

允许状态固定为：`NOT_STARTED`、`IMPLEMENTING`、`IMPLEMENTED_UNVERIFIED`、`VERIFIED`、`BLOCKED`。`requirements.yaml` 必须准确包含 REQ-AM-01 至 REQ-AM-15 各一次，全部初始化为：

```yaml
status: NOT_STARTED
implementation_locations: []
test_evidence: []
deployment_evidence: []
transaction_evidence: []
last_verified_at: null
blockers: []
```

`VERIFIED` 必须同时有实现位置、测试证据、非空 `last_verified_at`，并至少有部署或交易证据之一。路径必须是仓库相对路径，禁止 `/Users/`、`file://`、秘密格式和占位哈希。

- [ ] **Step 4: 运行 Evidence 与仓库门禁**

Run: `node --test scripts/validate-evidence.test.mjs && node scripts/validate-evidence.mjs && node scripts/validate-repository.mjs`  
Expected: 全部 PASS；15 项仍是 `NOT_STARTED`。

- [ ] **Step 5: 提交**

```bash
git add docs/evidence scripts package.json pnpm-lock.yaml
git commit -m "chore: establish truthful evidence ledger"
```

## Task 8: 非部署 CI 聚合门禁

**Files:**
- Create: `.github/workflows/verify.yml`
- Modify: `package.json`
- Create: `scripts/verify-all.mjs`
- Create: `scripts/verify-all.test.mjs`

**Interfaces:**
- Consumes: Node、pnpm、Go、Python 与 Hardhat 本地命令。
- Produces: PR `verify` check；不含 AWS、Cloudflare、Sepolia deploy 权限。

- [ ] **Step 1: 写失败的命令清单测试**

```js
test("verification contains every runtime and no deploy command", () => {
  assert.deepEqual(VERIFY_COMMANDS.map((item) => item.id), [
    "repository", "evidence", "typescript", "contracts", "go", "python",
  ]);
  assert.equal(VERIFY_COMMANDS.some((item) => /deploy|wrangler|terraform apply|hardhat run/.test(item.command)), false);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test scripts/verify-all.test.mjs`  
Expected: FAIL，`VERIFY_COMMANDS` 尚未定义。

- [ ] **Step 3: 实现聚合器和 GitHub workflow**

`VERIFY_COMMANDS` 固定执行：

```js
export const VERIFY_COMMANDS = [
  { id: "repository", command: "node scripts/validate-repository.mjs" },
  { id: "evidence", command: "node scripts/validate-evidence.mjs" },
  { id: "typescript", command: "pnpm -r --if-present test && pnpm -r --if-present typecheck && pnpm -r --if-present build" },
  { id: "contracts", command: "pnpm --filter @agent-market/contracts test" },
  { id: "go", command: "cd services/matcher-go && go vet ./... && go test ./..." },
  { id: "python", command: "cd services/trainer && .venv/bin/pytest -q" },
];
```

`.github/workflows/verify.yml` 只响应 `pull_request` 和手动 `workflow_dispatch`；权限为 `contents: read`；不得声明 AWS、Cloudflare、wallet 或 deployment environment secret。Python job 使用临时 venv，Node job 使用 frozen lockfile，Go job启用 module cache。

- [ ] **Step 4: 运行完整本地门禁**

Run: `node scripts/verify-all.mjs`  
Expected: 所有子门禁 PASS；无网络部署动作。

- [ ] **Step 5: 提交**

```bash
git add .github/workflows/verify.yml package.json scripts
git commit -m "ci: add non-deploy foundation verification"
```

## A1 Exit Gate

A1 只有满足以下条件才结束：

- 根 workspace、Transaction Engine、shared contracts 和 Hardhat 可独立构建。
- Go matcher 通过 `gofmt`、`go vet`、`go test`。
- Python trainer 测试通过且本地镜像可构建。
- TypeScript、Go 对同一 `match.requested.v1` fixture 的接受/拒绝结果一致。
- REQ-AM-01..15 仍全部诚实显示 `NOT_STARTED`，除非对应实现和测试已真实产生；A1 不产生部署或交易证据。
- CI 不含 deploy、付费资源、生产 secret 或主网配置。
- 前端目录仍未创建，UI Gate 状态仍为“待视觉验收”。

## 后续独立计划

A1 通过后按顺序另写并评审：

1. A2：YD、Escrow、StakeYieldVault、ArbitrationCommittee 完整合约与本地闭环。
2. A3：钱包会话、Agent Registry、加密凭证、Task 状态机、outbox 与 PostgreSQL migration。
3. A4：pgvector 召回、Go 排序、SQS/DLQ、反馈样本和模型激活。
4. A5：Stitch UI Gate 通过后的 Desktop/H5 生产前端。
5. A6：AWS IaC、一次性 ECS 训练、Cloudflare Edge、Ops 和 Web Vitals。
6. A7：Sepolia、预览/生产发布、真实交易、Evidence 与清理闭环。
