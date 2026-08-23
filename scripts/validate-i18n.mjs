import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const surfaces = [
  "apps/web/src/components/Shell.tsx",
  "apps/web/src/components/Ui.tsx",
  "apps/web/src/pages/ControlPages.tsx",
  "apps/web/src/pages/DirectoryPages.tsx",
  "apps/web/src/pages/EvidencePage.tsx",
  "apps/web/src/evidence/FullChainEvidence.tsx",
  "apps/web/src/pages/HomePage.tsx",
  "apps/web/src/pages/LocalAgentsPage.tsx",
  "apps/web/src/pages/NotFoundPage.tsx",
  "apps/web/src/pages/WorkflowPages.tsx",
];

export function validateI18n(base = root) {
  const dictionary = ["translations.ts", "translations.extended.ts"].map((file) => readFileSync(path.join(base, "apps/web/src/i18n", file), "utf8")).join("\n");
  const translated = new Set([...dictionary.matchAll(/"((?:\\.|[^"\\])+)"\s*:\s*"/g)].map((match) => match[1].replace(/\\"/g, '"')));
  const missing = new Set();
  for (const file of surfaces) {
    const source = readFileSync(path.join(base, file), "utf8");
    const candidates = [
      ...[...source.matchAll(/\b(?:alt|aria-label|description|eyebrow|label|note|placeholder|subtitle|text|title)="([^"]+)"/g)].map((match) => match[1]),
      ...[...source.matchAll(/>\s*([^<>{}\n][^<>{}\n]*?)\s*</g)].map((match) => match[1]),
      ...[...source.matchAll(/{\s*"([^"]+)"\s*}/g)].map((match) => match[1]),
    ];
    for (const candidate of candidates) {
      const value = candidate.trim();
      if (requiresTranslation(value) && !translated.has(value)) missing.add(`${file}:${value}`);
    }
  }
  const fixtureSource = readFileSync(path.join(base, "apps/web/src/data.ts"), "utf8");
  const fixtureCopy = [...fixtureSource.matchAll(/\b(?:due|summary|title):\s*"([^"]+)"/g)].map((match) => match[1]);
  for (const value of fixtureCopy) {
    if (requiresTranslation(value) && !translated.has(value) && !/^\d+ hours$/.test(value)) missing.add(`apps/web/src/data.ts:${value}`);
  }
  const homeSource = readFileSync(path.join(base, "apps/web/src/pages/HomePage.tsx"), "utf8");
  const homeCardCopy = [...homeSource.matchAll(/\["\d{2}",\s*"([^"]+)",\s*"([^"]+)"\]/g)].flatMap((match) => [match[1], match[2]]);
  for (const value of homeCardCopy) {
    if (requiresTranslation(value) && !translated.has(value)) missing.add(`apps/web/src/pages/HomePage.tsx:${value}`);
  }
  const catalogSource = readFileSync(path.join(base, "apps/web/src/agentCatalog.ts"), "utf8");
  const catalogCopy = [
    ...[...catalogSource.matchAll(/\bnote:\s*"([^"]+)"/g)].map((match) => match[1]),
    ...[...catalogSource.matchAll(/providerAgent\([^\n]+,\s*"([^"]+)"\),?$/gm)].map((match) => match[1]),
  ];
  for (const value of catalogCopy) {
    if (requiresTranslation(value) && !translated.has(value)) missing.add(`apps/web/src/agentCatalog.ts:${value}`);
  }
  return [...missing].sort();
}

export function findMissingLocalizedArchitectureAssets(base = root) {
  const evidencePage = readFileSync(path.join(base, "apps/web/src/pages/EvidencePage.tsx"), "utf8");
  const referencedAssets = new Set(
    [...evidencePage.matchAll(/src=["']\/architecture\/([^"']+\.svg)["']/g)]
      .map((match) => match[1])
      .filter((asset) => !asset.endsWith(".zh-CN.svg")),
  );

  return [...referencedAssets]
    .filter((asset) => {
      const localizedAsset = asset.replace(/\.svg$/, ".zh-CN.svg");
      return !existsSync(path.join(base, "apps/web/public/architecture", localizedAsset));
    })
    .sort();
}

function requiresTranslation(value) {
  if (!/[A-Za-z]{2}/.test(value) || /^https?:\/\//.test(value)) return false;
  if (/=>|\b(?:Promise|Record|response\.json|onEvent)\b/.test(value)) return false;
  if (/^(?:Agent Market|Sepolia|MetaMask|YD|AWS|Cloudflare|GraphQL|Mastra|LangGraph|LangChain|Ollama|DeepSeek|Kimi|Qwen|Zhipu|RPC|ECS|SQS|DLQ|PostgreSQL|Blockscout|Etherscan|Web Vitals|API Key|V\d(?: C-PLANE)?)$/.test(value)) return false;
  if (/^[A-Z0-9_./:-]+$/.test(value)) return false;
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const missing = validateI18n();
  const missingAssets = findMissingLocalizedArchitectureAssets();
  if (missing.length > 0 || missingAssets.length > 0) {
    console.error(`[i18n] ${missing.length} visible English strings and ${missingAssets.length} architecture assets lack zh-CN coverage`);
    for (const item of missing) console.error(`- ${item}`);
    for (const item of missingAssets) console.error(`- apps/web/public/architecture/${item.replace(/\.svg$/, ".zh-CN.svg")}`);
    process.exitCode = 1;
  } else {
    console.log("[i18n] PASS: static copy, dynamic fixtures, and architecture assets have zh-CN coverage");
  }
}
