import { AgentManifestSchema, OwnerTrainedModels, type AgentManifest } from "@agent-market/shared-contracts";

import type { RunnerConfig } from "./config";
import { isModelAllowed } from "./config";
import type { OllamaClient, OllamaShow, OllamaTag } from "./ollama-client";

type ManifestClock = () => Date;

export async function discoverOllamaManifests(
  client: Pick<OllamaClient, "listTags" | "show">,
  config: RunnerConfig,
  signal?: AbortSignal,
  clock: ManifestClock = () => new Date(),
): Promise<AgentManifest[]> {
  const tags = await client.listTags(signal);
  const manifests: AgentManifest[] = [];

  for (const tag of tags) {
    if (!isModelAllowed(tag.name, config.ollamaModelAllowlist)) {
      continue;
    }
    if (isEmbeddingOnly(tag)) {
      continue;
    }

    let show: OllamaShow;
    try {
      show = await client.show(tag.name, signal);
    } catch {
      continue;
    }
    let manifest: AgentManifest | undefined;
    try {
      manifest = ollamaMetadataToManifest(tag, show, config, clock());
    } catch {
      continue;
    }
    if (manifest !== undefined) {
      manifests.push(manifest);
    }
  }

  return manifests;
}

export function ollamaMetadataToManifest(
  tag: OllamaTag,
  show: OllamaShow,
  config: RunnerConfig,
  now: Date = new Date(),
): AgentManifest | undefined {
  if (isEmbeddingOnly(show)) {
    return undefined;
  }

  const details = { ...tag.details, ...show.details };
  const ownerModel = OwnerTrainedModels.find((model) => model.tag === tag.name);
  const isOwnerModel = ownerModel !== undefined && tag.digest === ownerModel.digest;
  if (ownerModel !== undefined && !isOwnerModel) {
    return undefined;
  }
  const capabilities = ownerModel === undefined
    ? toCompletionCapabilities(show.capabilities ?? tag.capabilities)
    : [...ownerModel.capabilities];
  const digest = ownerModel?.digest ?? tag.digest;

  if (digest === undefined || !/^[0-9a-f]{64}$/.test(digest)) {
    return undefined;
  }

  return AgentManifestSchema.parse({
    id: ownerModel?.id ?? slugify(tag.name),
    displayName: ownerModel?.displayName ?? toDisplayName(tag.name),
    ownership: isOwnerModel ? "owner-trained" : "third-party/local-served",
    provider: "ollama",
    capabilities,
    toolSchemas: [],
    model: {
      tag: tag.name,
      digest,
      parentModel: ownerModel?.parentModel ?? readNonEmpty(details.parent_model) ?? readString(show.model_info, "general.basename"),
      ...(ownerModel?.revision === undefined ? {} : { revision: ownerModel.revision }),
      family: ownerModel?.family ?? details.family ?? readString(show.model_info, "general.architecture") ?? "pending metadata",
      parameterSize: ownerModel?.parameterSize ?? details.parameter_size ?? "pending metadata",
      quantization: ownerModel?.quantization ?? details.quantization_level ?? "pending metadata",
      contextLength: ownerModel?.contextLength ?? details.context_length ?? readPositiveInteger(show.model_info, "llama.context_length") ?? 4096,
      embeddingLength: details.embedding_length ?? readPositiveInteger(show.model_info, "llama.embedding_length"),
      source: ownerModel?.source ?? "local-served via Ollama",
      license: ownerModel?.license ?? show.license ?? "pending metadata",
    },
    health: {
      status: "online",
      lastHeartbeatAt: now.toISOString(),
      lastVerifiedAt: now.toISOString(),
    },
    limits: {
      maxConcurrency: config.maxConcurrency,
      timeoutMs: config.timeoutMs,
      maxPayloadBytes: config.maxPayloadBytes,
    },
    access: {
      visibility: "private",
      selectableBy: "owner-only",
      ownerScope: "local-runtime-owner",
    },
  });
}

function isEmbeddingOnly(source: Pick<OllamaShow, "capabilities">): boolean {
  const capabilities = source.capabilities ?? [];
  return capabilities.length > 0 && capabilities.includes("embedding") && !capabilities.includes("completion");
}

function toCompletionCapabilities(capabilities: string[] | undefined): AgentManifest["capabilities"] {
  const parsed: AgentManifest["capabilities"] = ["completion"];
  if (capabilities?.includes("thinking")) {
    parsed.push("thinking");
  }
  if (capabilities?.includes("tools")) {
    parsed.push("tools");
  }
  return parsed;
}

function readString(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key];
  return readNonEmpty(value);
}

function readNonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readPositiveInteger(source: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = source?.[key];
  return Number.isInteger(value) && typeof value === "number" && value > 0 ? value : undefined;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function toDisplayName(value: string): string {
  return value
    .replace(/[:_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
