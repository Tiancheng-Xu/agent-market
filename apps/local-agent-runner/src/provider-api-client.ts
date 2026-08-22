import type { ChatMessage } from "./ollama-client";

export type ProviderName = "deepseek" | "kimi" | "qwen" | "zhipu";

export type ProviderDefinition = {
  provider: ProviderName;
  baseUrl: string;
  baseUrlEnvKeys: readonly string[];
  envKeys: readonly string[];
  modelEnvKeys: readonly string[];
  defaultModel: string;
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
    defaultModel: "deepseek-v4-flash",
    family: "deepseek",
    source: "DeepSeek API",
  },
  kimi: {
    provider: "kimi",
    baseUrl: "https://api.moonshot.ai/v1",
    baseUrlEnvKeys: ["MOONSHOT_BASE_URL", "KIMI_BASE_URL"],
    envKeys: ["MOONSHOT_API_KEY", "KIMI_API_KEY"],
    modelEnvKeys: ["MOONSHOT_MODEL", "KIMI_MODEL"],
    defaultModel: "kimi-k3",
    family: "kimi",
    source: "Moonshot Kimi API",
  },
  qwen: {
    provider: "qwen",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    baseUrlEnvKeys: ["QWEN_BASE_URL", "DASHSCOPE_BASE_URL"],
    envKeys: ["QWEN_API_KEY", "DASHSCOPE_API_KEY"],
    modelEnvKeys: ["QWEN_MODEL", "DASHSCOPE_MODEL"],
    defaultModel: "qwen-plus",
    family: "qwen",
    source: "Alibaba Cloud Model Studio Qwen API",
  },
  zhipu: {
    provider: "zhipu",
    baseUrl: "https://api.z.ai/api/paas/v4",
    baseUrlEnvKeys: ["ZHIPU_BASE_URL", "ZAI_BASE_URL", "BIGMODEL_BASE_URL"],
    envKeys: ["ZHIPU_API_KEY", "ZAI_API_KEY", "BIGMODEL_API_KEY"],
    modelEnvKeys: ["ZHIPU_MODEL", "ZAI_MODEL", "BIGMODEL_MODEL"],
    defaultModel: "glm-5.3",
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
  const model = readFirstNonEmpty(definition.modelEnvKeys, env) ?? definition.defaultModel;
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(model)) {
    throw new Error(`${definition.provider} model id is invalid`);
  }
  if (model.includes(":")) {
    throw new Error(`${definition.provider} model id must not look like an Ollama tag`);
  }
  return model;
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
