import { AgentManifestSchema, type AgentManifest } from "@agent-market/shared-contracts";

import type { RunnerConfig } from "./config";
import { PROVIDER_MANAGED_DIGEST } from "./config";
import {
  PROVIDERS,
  readProviderApiKey,
  readProviderModel,
  readProviderModels,
  type ProviderEnv,
  type ProviderName,
} from "./provider-api-client";

type ManifestClock = () => Date;

export function providerManifest(
  provider: ProviderName,
  config: RunnerConfig,
  env: ProviderEnv = process.env,
  clock: ManifestClock = () => new Date(),
): AgentManifest {
  const definition = PROVIDERS[provider];
  const model = readProviderModel(definition, env);
  return providerManifestForModel(provider, model, config, env, clock);
}

export function providerManifestForModel(
  provider: ProviderName,
  model: string,
  config: RunnerConfig,
  env: ProviderEnv = process.env,
  clock: ManifestClock = () => new Date(),
): AgentManifest {
  const definition = PROVIDERS[provider];
  const configured = readProviderApiKey(definition, env) !== undefined;
  const now = clock().toISOString();

  return AgentManifestSchema.parse({
    id: `${provider}-${slugify(model)}`,
    displayName: toDisplayName(model),
    ownership: "third-party/provider-api",
    provider,
    capabilities: ["completion"],
    toolSchemas: [],
    model: {
      tag: model,
      digest: PROVIDER_MANAGED_DIGEST,
      family: definition.family,
      parameterSize: "provider-managed",
      quantization: "provider-managed",
      contextLength: 1_000_000,
      source: definition.source,
      license: "provider terms pending metadata",
    },
    health: {
      status: configured ? "degraded" : "offline",
      lastVerifiedAt: now,
    },
    limits: {
      maxConcurrency: config.maxConcurrency,
      timeoutMs: config.timeoutMs,
      maxPayloadBytes: config.maxPayloadBytes,
    },
  });
}

export function providerManifests(
  config: RunnerConfig,
  env: ProviderEnv = process.env,
  clock: ManifestClock = () => new Date(),
): AgentManifest[] {
  return (Object.keys(PROVIDERS) as ProviderName[]).flatMap((provider) => {
    const definition = PROVIDERS[provider];
    return readProviderModels(definition, env).map((model) => providerManifestForModel(provider, model, config, env, clock));
  });
}

function toDisplayName(value: string): string {
  return value
    .replace(/[:._-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
