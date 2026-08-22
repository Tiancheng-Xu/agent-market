import type { ChatMessage } from "./ollama-client";

export type ProviderName = "deepseek" | "kimi" | "qwen" | "zhipu";

export type ProviderDefinition = {
  provider: ProviderName;
  baseUrl: string;
  baseUrlEnvKeys: readonly string[];
  envKeys: readonly string[];
  modelEnvKeys: readonly string[];
  modelListEnvKeys: readonly string[];
  defaultModel: string;
  defaultModels: readonly string[];
  family: string;
  source: string;
};

export const PROVIDERS: Record<ProviderName, ProviderDefinition> = {
  deepseek: {
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    baseUrlEnvKeys: ["DEEPSEEK_BASE_URL"],
    envKeys: ["DEEPSEEK_API_KEY"],
    modelEnvKeys: ["DEEPSEEK_MODEL"],
    modelListEnvKeys: ["DEEPSEEK_MODELS"],
    defaultModel: "deepseek-v4-flash",
    defaultModels: ["deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner"],
    family: "deepseek",
    source: "DeepSeek API",
  },
  kimi: {
    provider: "kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    baseUrlEnvKeys: ["MOONSHOT_BASE_URL", "KIMI_BASE_URL"],
    envKeys: ["MOONSHOT_API_KEY", "KIMI_API_KEY"],
    modelEnvKeys: ["MOONSHOT_MODEL", "KIMI_MODEL"],
    modelListEnvKeys: ["MOONSHOT_MODELS", "KIMI_MODELS"],
    defaultModel: "kimi-k2.7-code",
    defaultModels: ["kimi-k2.7-code", "kimi-k3", "kimi-k2.6", "kimi-k2.7-code-highspeed"],
    family: "kimi",
    source: "Moonshot Kimi API",
  },
  qwen: {
    provider: "qwen",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    baseUrlEnvKeys: ["QWEN_BASE_URL", "DASHSCOPE_BASE_URL"],
    envKeys: ["QWEN_API_KEY", "DASHSCOPE_API_KEY"],
    modelEnvKeys: ["QWEN_MODEL", "DASHSCOPE_MODEL"],
    modelListEnvKeys: ["QWEN_MODELS", "DASHSCOPE_MODELS"],
    defaultModel: "qwen-plus",
    defaultModels: ["qwen-plus", "qwen-turbo", "qwen-max", "qwen-long"],
    family: "qwen",
    source: "Alibaba Cloud Model Studio Qwen API",
  },
  zhipu: {
    provider: "zhipu",
    baseUrl: "https://api.z.ai/api/paas/v4",
    baseUrlEnvKeys: ["ZHIPU_BASE_URL", "ZAI_BASE_URL", "BIGMODEL_BASE_URL"],
    envKeys: ["ZHIPU_API_KEY", "ZAI_API_KEY", "BIGMODEL_API_KEY"],
    modelEnvKeys: ["ZHIPU_MODEL", "ZAI_MODEL", "BIGMODEL_MODEL"],
    modelListEnvKeys: ["ZHIPU_MODELS", "ZAI_MODELS", "BIGMODEL_MODELS"],
    defaultModel: "glm-5.3",
    defaultModels: ["glm-5.3", "glm-4.5", "glm-4.5-air", "glm-4-flash"],
    family: "glm",
    source: "Z.AI / Zhipu AI OpenAI-compatible API",
  },
};

export type ProviderChatRequest = {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
};

export type ProviderEnv = Record<string, string | undefined>;
export type ProviderFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class ProviderApiClient {
  readonly #definition: ProviderDefinition;
  readonly #apiKey: string;
  readonly #model: string;
  readonly #fetch: ProviderFetch;
  readonly #timeoutMs: number;
  readonly #maxPayloadBytes: number;

  constructor(
    definition: ProviderDefinition,
    apiKey: string,
    timeoutMs: number,
    maxPayloadBytes: number,
    fetchLike: ProviderFetch = fetch,
    model: string = definition.defaultModel,
  ) {
    this.#definition = definition;
    this.#apiKey = apiKey;
    this.#model = model;
    this.#fetch = fetchLike;
    this.#timeoutMs = timeoutMs;
    this.#maxPayloadBytes = maxPayloadBytes;
  }

  async chat(request: ProviderChatRequest, signal?: AbortSignal): Promise<unknown> {
    const body = JSON.stringify({
      model: request.model ?? this.#model,
      messages: request.messages,
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      stream: false,
    });

    if (new TextEncoder().encode(body).byteLength > this.#maxPayloadBytes) {
      throw new Error("Provider request payload exceeds configured limit");
    }

    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const response = await this.#fetch(`${this.#definition.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        "content-type": "application/json",
      },
      body,
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });

    if (!response.ok) {
      throw new Error(`${this.#definition.provider} request failed with status ${response.status}`);
    }

    return response.json();
  }
}

export function readProviderApiKey(definition: ProviderDefinition, env: ProviderEnv): string | undefined {
  return readFirstNonEmpty(definition.envKeys, env);
}

export function readProviderModel(definition: ProviderDefinition, env: ProviderEnv): string {
  return readProviderModels(definition, env)[0] ?? definition.defaultModel;
}

export function readProviderModels(definition: ProviderDefinition, env: ProviderEnv): string[] {
  const configuredList = readFirstNonEmpty(definition.modelListEnvKeys, env);
  const configuredSingle = readFirstNonEmpty(definition.modelEnvKeys, env);
  const values = configuredList !== undefined
    ? configuredList.split(/[\s,]+/).filter(Boolean)
    : configuredSingle !== undefined
      ? [configuredSingle]
      : [...definition.defaultModels];
  const models = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  for (const model of models) validateProviderModel(definition, model);
  return models;
}

function validateProviderModel(definition: ProviderDefinition, model: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(model)) {
    throw new Error(`${definition.provider} model id is invalid`);
  }
  if (model.includes(":")) {
    throw new Error(`${definition.provider} model id must not look like an Ollama tag`);
  }
}

export function readProviderBaseUrl(definition: ProviderDefinition, env: ProviderEnv): string {
  const baseUrl = readFirstNonEmpty(definition.baseUrlEnvKeys, env) ?? definition.baseUrl;
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") {
    throw new Error(`${definition.provider} base URL is invalid`);
  }

  return parsed.toString().replace(/\/$/, "");
}

function readFirstNonEmpty(keys: readonly string[], env: ProviderEnv): string | undefined {
  for (const key of keys) {
    const value = env[key];
    if (value !== undefined && value.trim() !== "") {
      return value;
    }
  }

  return undefined;
}
