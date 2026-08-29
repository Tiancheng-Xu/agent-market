import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readEvidence, validateEvidence, validateEvidenceRepository } from "./validate-evidence.mjs";

const TITLES = [
  "Agent full-fields onboarding and wallet binding",
  "End-to-end ID and encrypted/redacted credentials",
  "Task publishing and Sepolia escrow",
  "Hard filters, vector recall, randomized exploration, max 3",
  "Five score categories, thresholds, explanations",
  "Feedback features and nightly CTR training",
  "Three-member committee and two-vote ruling",
  "Two YD airdrops",
  "Escrow, bond, and staking at 6% linear annual yield",
  "React, Vite, Tailwind, and MetaMask",
  "Next.js and Lambda transaction adapter",
  "Go scheduler adapter",
  "PostgreSQL, SQS, SNS, DLQ, and pgvector",
  "One-shot ECS training",
  "Cloudflare, AWS, PR environments, CI, observability, AI Ops, and Codex record",
];

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DEPLOYMENT_EVIDENCE = [
  "sepolia-workflow-v3.json",
  "2026-08-28-sepolia-v3-interaction-closure.json",
];

export function generatePublicEvidence(root = REPOSITORY_ROOT) {
  const document = readEvidence(resolve(root, "docs/evidence/requirements.yaml"));
  const violations = validateEvidence(document);
  violations.push(...validateEvidenceRepository(root, { includeClosureGates: false }));
  if (violations.length > 0) throw new Error(violations.join("\n"));

  const requirements = document.requirements.map((requirement, index) => ({
    ...requirement,
    title: TITLES[index],
  }));
  const output = resolve(root, "apps/web/src/generated/requirements.json");
  mkdirSync(resolve(root, "apps/web/src/generated"), { recursive: true });
  writeFileSync(output, `${JSON.stringify({ requirements }, null, 2)}\n`);
  const phase2 = JSON.parse(readFileSync(resolve(root, "docs/evidence/phase2-local-validation.json"), "utf8"));
  writeFileSync(resolve(root, "apps/web/src/evidence/phase2-evidence.generated.json"), `${JSON.stringify(phase2, null, 2)}\n`);
  const publicEvidence = resolve(root, "apps/web/public/evidence");
  mkdirSync(publicEvidence, { recursive: true });
  for (const file of PUBLIC_DEPLOYMENT_EVIDENCE) {
    copyFileSync(resolve(root, "docs/evidence/deployment", file), resolve(publicEvidence, file));
  }
  return output;
}

if (process.argv[1]?.endsWith("generate-public-evidence.mjs")) {
  generatePublicEvidence();
}
