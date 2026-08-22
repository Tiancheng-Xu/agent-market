import type { RunnerConfig } from "./config";

export type OllamaTag = {
  name: string;
  digest?: string;
  capabilities?: string[];
  details?: {
    context_length?: number;
    embedding_length?: number;
    family?: string;
    parent_model?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
};

export type OllamaShow = {
  details?: OllamaTag["details"];
  model_info?: Record<string, unknown>;
  capabilities?: string[];
  license?: string;
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
};

export type OllamaChatRequest = {
  model: string;
  messages: ChatMessage[];
  options?: Record<string, unknown>;
  think?: boolean;
};

export type OllamaChatStreamDelta = {
  content: string;
  raw: unknown;
};

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class OllamaClient {
  readonly #origin: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #maxPayloadBytes: number;

  constructor(config: RunnerConfig, fetchLike: FetchLike = fetch) {
    this.#origin = config.ollamaOrigin;
    this.#fetch = fetchLike;
    this.#timeoutMs = config.timeoutMs;
    this.#maxPayloadBytes = config.maxPayloadBytes;
  }

  async listTags(signal?: AbortSignal): Promise<OllamaTag[]> {
    const payload = await this.#request<{ models?: OllamaTag[] }>("/api/tags", { method: "GET" }, signal);
    return payload.models ?? [];
  }

  async show(model: string, signal?: AbortSignal): Promise<OllamaShow> {
    return this.#request<OllamaShow>(
      "/api/show",
      {
        method: "POST",
        body: JSON.stringify({ model }),
      },
      signal,
    );
  }

  async chat(request: OllamaChatRequest, signal?: AbortSignal): Promise<unknown> {
    return this.#request(
      "/api/chat",
      {
        method: "POST",
        body: JSON.stringify({ ...request, think: request.think ?? false, stream: false }),
      },
      signal,
    );
  }

  async chatStream(
    request: OllamaChatRequest,
    onDelta: (delta: OllamaChatStreamDelta) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await this.#rawRequest(
      "/api/chat",
      {
        method: "POST",
        body: JSON.stringify({ ...request, think: request.think ?? false, stream: true }),
      },
      signal,
    );
    if (response.body === null) {
      throw new Error("Ollama stream response was empty");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          emitOllamaLine(line, onDelta);
        }
      }
      if (buffer.trim().length > 0) emitOllamaLine(buffer, onDelta);
    } finally {
      reader.releaseLock();
    }
  }

  async #request<T>(path: "/api/tags" | "/api/show" | "/api/chat", init: RequestInit, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const body = typeof init.body === "string" ? init.body : undefined;
    if (body !== undefined && new TextEncoder().encode(body).byteLength > this.#maxPayloadBytes) {
      throw new Error("Ollama request payload exceeds configured limit");
    }

    const response = await this.#rawRequest(path, init, signal);

    return response.json() as Promise<T>;
  }

  async #rawRequest(path: "/api/tags" | "/api/show" | "/api/chat", init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const body = typeof init.body === "string" ? init.body : undefined;
    if (body !== undefined && new TextEncoder().encode(body).byteLength > this.#maxPayloadBytes) {
      throw new Error("Ollama request payload exceeds configured limit");
    }

    const response = await this.#fetch(`${this.#origin}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...init.headers },
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });

    if (!response.ok) {
      throw new Error(`Ollama request failed with status ${response.status}`);
    }

    return response;
  }
}

function emitOllamaLine(line: string, onDelta: (delta: OllamaChatStreamDelta) => void): void {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  const raw = JSON.parse(trimmed) as unknown;
  if (!isRecord(raw)) return;
  const message = raw["message"];
  if (isRecord(message) && typeof message["content"] === "string" && message["content"].length > 0) {
    onDelta({ content: message["content"], raw });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
