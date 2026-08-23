import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const VERIFY_COMMANDS = [
  { id: "repository", command: "node scripts/validate-repository.mjs" },
  { id: "regression-contract", command: "node scripts/validate-regression-gates.mjs" },
  { id: "i18n", command: "node scripts/validate-i18n.mjs" },
  { id: "i18n-routes", command: "pnpm --dir apps/web exec vitest run src/i18n/LocalizedRoutes.test.tsx" },
  { id: "evidence", command: "node scripts/validate-evidence.mjs" },
  { id: "typescript", command: "pnpm -r --if-present test && pnpm -r --if-present typecheck && pnpm -r --if-present build" },
  { id: "contracts", command: "pnpm --filter @agent-market/contracts test" },
  { id: "go", command: "cd services/matcher-go && go vet ./... && go test ./..." },
  { id: "python", command: "cd services/trainer && PYTHONPATH=src .venv/bin/pytest -q" },
];

export function verifyAll(commands = VERIFY_COMMANDS) {
  for (const item of commands) {
    console.log(`\n[verify:${item.id}] ${item.command}`);
    const result = spawnSync(item.command, { shell: true, stdio: "inherit" });
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = verifyAll();
}
