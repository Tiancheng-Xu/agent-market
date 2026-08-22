import type { Agent } from "./types";

export type CatalogProvider = "ollama" | "deepseek" | "kimi" | "qwen" | "zhipu";
export type AgentOwnership = "owner-trained" | "third-party/local-served" | "third-party/provider-api";
export type AgentVerification = "verified" | "implemented" | "pending-smoke" | "pending-credential" | "planned";
export type AgentVisibility = "private" | "listed" | "marketplace";
export type AgentSelectableBy = "owner-only" | "assigned-task" | "public-market";

export type PublicAgentCatalogEntry = {
  id: string;
  displayName: string;
  category: string;
  provider: CatalogProvider;
  providerLabel: string;
  ownership: AgentOwnership;
  modelTag: string;
  modelDigest: string;
  visibility: AgentVisibility;
  selectableBy: AgentSelectableBy;
  capabilities: string[];
  verification: AgentVerification;
  source: string;
  license: string;
  readinessScore: number;
  verifiedOperations: number;
  note: string;
};

const providerLabels: Record<CatalogProvider, string> = {
  ollama: "Ollama",
  deepseek: "DeepSeek API",
  kimi: "Moonshot Kimi API",
  qwen: "Qwen API",
  zhipu: "Zhipu API",
};

export const publicAgentCatalog: PublicAgentCatalogEntry[] = [
  localAgent({
    id: "personal-ai-agent-runtime-v4-1",
    displayName: "Personal AI Runtime v4.1",
    ownership: "owner-trained",
    modelTag: "personal-ai-agent-runtime:v4.1",
    modelDigest: "2c422ec890241b8492e08d4ba69f79f25efcf8ae4220e83797d2df9cbc7eb52a",
    capabilities: ["completion", "thinking", "tools", "local-runtime"],
    verification: "verified",
    readinessScore: 96,
    verifiedOperations: 1,
    note: "Canonical owner-trained runtime. Served only through the signed local runtime boundary.",
  }),
  localAgent({
    id: "personal-ai-agent-v4-1",
    displayName: "Personal AI Historical v4.1",
    ownership: "owner-trained",
    modelTag: "personal-ai-agent:v4.1",
    modelDigest: "ef12e12a9ce8",
    capabilities: ["completion", "local-runtime"],
    verification: "pending-smoke",
    readinessScore: 62,
    note: "Historical self-trained model is installed locally, but this project has not run a fresh Agent Market smoke against it.",
  }),
  localAgent({
    id: "personal-ai-agent-v4",
    displayName: "Personal AI Historical v4",
    ownership: "owner-trained",
    modelTag: "personal-ai-agent:v4",
    modelDigest: "6a67b077ead9",
    capabilities: ["completion", "local-runtime"],
    verification: "pending-smoke",
    readinessScore: 60,
    note: "Earlier self-trained model is available as a fallback candidate after runtime smoke.",
  }),
  localAgent({
    id: "course-knowledge-assistant-v2-1",
    displayName: "Course Knowledge Assistant v2.1",
    ownership: "third-party/local-served",
    modelTag: "course-knowledge-assistant:v2.1",
    modelDigest: "e06673891dea",
    capabilities: ["completion", "course-qa", "local-runtime"],
    verification: "pending-smoke",
    readinessScore: 58,
    note: "Local served course assistant. It is not claimed as Agent Market owner-trained output.",
  }),
  localAgent({
    id: "qwen3-30b-instruct",
    displayName: "Qwen3 30B Instruct",
    ownership: "third-party/local-served",
    modelTag: "qwen3:30b-instruct",
    modelDigest: "19e422b02313",
    capabilities: ["completion", "reasoning", "local-runtime"],
    verification: "pending-smoke",
    readinessScore: 55,
    note: "Large local third-party model. It must pass runtime smoke before being advertised as online.",
  }),
  localAgent({
    id: "qwen2-5-coder-7b-code",
    displayName: "Qwen2.5 Coder 7B",
    ownership: "third-party/local-served",
    modelTag: "qwen2.5-coder:7b-code",
    modelDigest: "dae161e27b0e",
    capabilities: ["completion", "code", "local-runtime"],
    verification: "pending-smoke",
    readinessScore: 54,
    note: "Local code model candidate. Embedding-only models are intentionally excluded from this chat agent catalog.",
  }),
  localAgent({
    id: "gemma3-4b-picture",
    displayName: "Gemma3 4B Picture",
    ownership: "third-party/local-served",
    modelTag: "gemma3:4b-picture",
    modelDigest: "a2af6cc3eb7f",
    capabilities: ["completion", "vision", "local-runtime"],
    verification: "pending-smoke",
    readinessScore: 50,
    note: "Local multimodal candidate. It is listed as pending until the runtime validates the vision/text adapter path.",
  }),
  providerAgent("deepseek", "deepseek-v4-flash", "verified", 92, 1, ["completion", "fast-draft"], "Verified provider smoke through the server-side adapter."),
  providerAgent("deepseek", "deepseek-chat", "pending-smoke", 64, 0, ["completion"], "Provider-supported candidate; configured credentials are required before live use."),
  providerAgent("deepseek", "deepseek-reasoner", "pending-smoke", 64, 0, ["completion", "reasoning"], "Reasoning model candidate for judge or adversarial nodes after smoke."),
  providerAgent("kimi", "kimi-k2.7-code", "verified", 91, 1, ["completion", "code"], "Verified with the Moonshot China endpoint. The key stays server-side."),
  providerAgent("kimi", "kimi-k3", "pending-smoke", 66, 0, ["completion", "reasoning"], "Model is visible from the provider catalog but needs a clean Agent Market smoke before verified status."),
  providerAgent("kimi", "kimi-k2.6", "pending-smoke", 65, 0, ["completion", "reasoning"], "Provider catalog candidate; previous probes produced reasoning output but not a clean delivery smoke."),
  providerAgent("kimi", "kimi-k2.7-code-highspeed", "pending-smoke", 64, 0, ["completion", "code", "fast-draft"], "High-speed code model candidate for low-latency code nodes after smoke."),
  providerAgent("qwen", "qwen-plus", "verified", 90, 1, ["completion", "general"], "Verified through DashScope OpenAI-compatible chat completions."),
  providerAgent("qwen", "qwen-turbo", "pending-smoke", 62, 0, ["completion", "fast-draft"], "Provider model candidate. It remains pending until smoke evidence exists."),
  providerAgent("qwen", "qwen-max", "pending-smoke", 63, 0, ["completion", "reasoning"], "Provider model candidate for higher-quality synthesis after smoke."),
  providerAgent("qwen", "qwen-long", "pending-smoke", 61, 0, ["completion", "long-context"], "Provider long-context candidate after runtime smoke and budget limits are confirmed."),
  providerAgent("zhipu", "glm-5.3", "verified", 90, 1, ["completion", "general"], "Verified through the Z.AI / Zhipu OpenAI-compatible endpoint."),
  providerAgent("zhipu", "glm-4.5", "pending-smoke", 62, 0, ["completion", "reasoning"], "Provider model candidate. It remains pending until live smoke evidence exists."),
  providerAgent("zhipu", "glm-4.5-air", "pending-smoke", 61, 0, ["completion", "fast-draft"], "Lower-cost provider model candidate for draft nodes after smoke."),
  providerAgent("zhipu", "glm-4-flash", "pending-smoke", 60, 0, ["completion", "fast-draft"], "Flash model candidate after provider and quota smoke."),
];

export const publicAgentCatalogResponse = {
  schemaVersion: "agent-market.catalog.v1",
  endpoints: {
    catalog: "/agent/catalog",
    health: "/agent/healthz",
    chat: "/agent/chat",
    orchestration: "/agent/graphql",
  },
  types: {
    sharedContract: "packages/shared-contracts/src/local-agent.ts",
    webCatalog: "apps/web/src/agentCatalog.ts",
  },
  healthSemantics: {
    online: "runtime/provider is reachable and has current positive readiness evidence",
    degraded: "credentials or adapter exist, but live readiness is not fully verified for the current model",
    offline: "runtime is not configured, unreachable, or the model must not be selected for live work",
  },
  errorCodes: [
    "VALIDATION_FAILED",
    "FORBIDDEN",
    "REQUEST_TOO_LARGE",
    "TURNSTILE_FAILED",
    "RUNTIME_OFFLINE",
    "UPSTREAM_TIMEOUT",
    "MODEL_UNAVAILABLE",
  ],
  redaction: [
    "No API keys, shared secrets, cookies, private local paths, model weights, or raw sensitive prompts are returned.",
    "Provider models expose only public model tags, provider labels, capability tags, access policy, and verification state.",
    "Local Ollama models are listed as private owner-only agents; the browser never receives a direct local model port.",
  ],
  selectionPolicy: {
    localUserAgents: "owner-only by default; public tasks cannot select them without an authenticated owner scope",
    threeChoicePool: "candidate ranking deduplicates by modelTag so one model cannot occupy multiple choices",
    scoreLifecycle: "new models start with no historical score and receive exploration boost; completed outcomes later add or subtract score; old low-score models are retired",
  },
  agents: publicAgentCatalog,
} as const;

export function catalogEntryToAgent(entry: PublicAgentCatalogEntry): Agent {
  return {
    id: entry.id,
    name: entry.displayName,
    category: entry.category,
    description: entry.note,
    tags: [
      entry.provider,
      entry.ownership,
      entry.selectableBy,
      entry.verification,
      ...entry.capabilities,
    ],
    reliability: entry.readinessScore,
    completed: entry.verifiedOperations,
    status: entry.verification === "verified" || entry.verification === "implemented" ? "active" : "suspended",
    provider: entry.providerLabel,
    ownership: entry.ownership,
    modelTag: entry.modelTag,
    modelDigest: entry.modelDigest,
    visibility: entry.visibility,
    selectableBy: entry.selectableBy,
    verification: entry.verification,
    source: entry.source,
    license: entry.license,
  };
}

export function agentProviderLabel(provider: CatalogProvider): string {
  return providerLabels[provider];
}

function localAgent(entry: Omit<PublicAgentCatalogEntry, "category" | "provider" | "providerLabel" | "source" | "license" | "visibility" | "selectableBy" | "verifiedOperations"> & { verifiedOperations?: number }): PublicAgentCatalogEntry {
  return {
    ...entry,
    category: entry.ownership === "owner-trained" ? "Local owner-trained" : "Local served",
    provider: "ollama",
    providerLabel: providerLabels.ollama,
    source: "Local Ollama runtime",
    license: entry.ownership === "owner-trained" ? "owner training artifact" : "upstream model terms pending metadata",
    visibility: "private",
    selectableBy: "owner-only",
    verifiedOperations: entry.verifiedOperations ?? 0,
  };
}

function providerAgent(
  provider: Exclude<CatalogProvider, "ollama">,
  modelTag: string,
  verification: AgentVerification,
  readinessScore: number,
  verifiedOperations: number,
  capabilities: string[],
  note: string,
): PublicAgentCatalogEntry {
  return {
    id: `${provider}-${slugify(modelTag)}`,
    displayName: toDisplayName(modelTag),
    category: "Provider API",
    provider,
    providerLabel: providerLabels[provider],
    ownership: "third-party/provider-api",
    modelTag,
    modelDigest: "provider-managed",
    visibility: "marketplace",
    selectableBy: "public-market",
    capabilities,
    verification,
    source: providerLabels[provider],
    license: "provider terms pending metadata",
    readinessScore,
    verifiedOperations,
    note,
  };
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function toDisplayName(value: string): string {
  return value
    .replace(/[:._-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
