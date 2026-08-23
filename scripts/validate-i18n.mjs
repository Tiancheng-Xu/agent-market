import { readFileSync } from "node:fs";
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
      ...[...source.matchAll(/\b(?:description|eyebrow|label|note|placeholder|title)="([^"]+)"/g)].map((match) => match[1]),
      ...[...source.matchAll(/>\s*([^<>{}\n][^<>{}\n]*?)\s*</g)].map((match) => match[1]),
    ];
    for (const candidate of candidates) {
      const value = candidate.trim();
      if (requiresTranslation(value) && !translated.has(value)) missing.add(`${file}:${value}`);
    }
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

function requiresTranslation(value) {
  if (!/[A-Za-z]{2}/.test(value) || /^https?:\/\//.test(value)) return false;
  if (/=>|\b(?:Promise|Record|response\.json|onEvent)\b/.test(value)) return false;
  if (/^(?:Agent Market|Sepolia|MetaMask|YD|AWS|Cloudflare|GraphQL|Mastra|LangGraph|LangChain|Ollama|DeepSeek|Kimi|Qwen|Zhipu|RPC|ECS|SQS|DLQ|PostgreSQL|Blockscout|Etherscan|Web Vitals|API Key|V\d(?: C-PLANE)?)$/.test(value)) return false;
  if (/^[A-Z0-9_./:-]+$/.test(value)) return false;
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const missing = validateI18n();
  if (missing.length > 0) {
    console.error(`[i18n] ${missing.length} visible English strings lack an exact zh-CN translation`);
    for (const item of missing) console.error(`- ${item}`);
    process.exitCode = 1;
  } else {
    console.log("[i18n] PASS: visible static copy has an exact zh-CN translation");
  }
}
