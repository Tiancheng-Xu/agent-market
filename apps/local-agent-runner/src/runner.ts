import {
  AgentTaskLeaseSchema,
  AgentTaskResultSchema,
  type AgentManifest,
  type AgentTaskLease,
  type AgentTaskResult,
} from "@agent-market/shared-contracts";

import type { ControlPlaneClient } from "./control-plane-client";
import type { ChatMessage, OllamaClient } from "./ollama-client";
import type { ProviderApiClient, ProviderName } from "./provider-api-client";

type ChatClient = Pick<OllamaClient, "chat">;
type ProviderClients = Partial<Record<ProviderName, Pick<ProviderApiClient, "chat">>>;
type ResultErrorCode = NonNullable<AgentTaskResult["error"]>["code"];

export type LocalAgentRunnerOptions = {
  manifests: AgentManifest[];
  controlPlane: Pick<ControlPlaneClient, "registerManifests" | "heartbeat" | "nextLease" | "submitResult">;
  ollamaClient: ChatClient;
  providerClients?: ProviderClients;
  now?: () => Date;
};

export type PollStatus = "processed" | "idle" | "saturated" | "stopped";

export class LocalAgentRunner {
  readonly #manifests: Map<string, AgentManifest>;
  readonly #controlPlane: LocalAgentRunnerOptions["controlPlane"];
  readonly #ollamaClient: ChatClient;
  readonly #providerClients: ProviderClients;
  readonly #now: () => Date;
  readonly #completed = new Map<string, AgentTaskResult>();
  readonly #inFlight = new Map<string, Promise<AgentTaskResult>>();
  readonly #controllers = new Set<AbortController>();
  #active = 0;
  #stopped = false;

  constructor(options: LocalAgentRunnerOptions) {
    this.#manifests = new Map(options.manifests.map((manifest) => [manifest.id, manifest]));
    this.#controlPlane = options.controlPlane;
    this.#ollamaClient = options.ollamaClient;
    this.#providerClients = options.providerClients ?? {};
    this.#now = options.now ?? (() => new Date());
  }

  async registerAll(signal?: AbortSignal): Promise<void> {
    await this.#controlPlane.registerManifests([...this.#manifests.values()], signal);
  }

  async heartbeat(signal?: AbortSignal): Promise<void> {
    await this.#controlPlane.heartbeat([...this.#manifests.keys()], signal);
  }

  async pollOnce(signal?: AbortSignal): Promise<PollStatus> {
    if (this.#stopped) {
      return "stopped";
    }
    if (this.#active >= this.#maxConcurrency()) {
      return "saturated";
    }

    let lease: AgentTaskLease | undefined;
    try {
      lease = await this.#controlPlane.nextLease(signal);
    } catch {
      return "idle";
    }

    if (lease === undefined) {
      return "idle";
    }

    const result = await this.#runLease(AgentTaskLeaseSchema.parse(lease), signal);
    await this.#controlPlane.submitResult(result, signal);
    return "processed";
  }

  stop(): void {
    this.#stopped = true;
    for (const controller of this.#controllers) {
      controller.abort();
    }
  }

  async #runLease(lease: AgentTaskLease, signal?: AbortSignal): Promise<AgentTaskResult> {
    const cached = this.#completed.get(lease.leaseId);
    if (cached !== undefined) {
      return cached;
    }

    const existing = this.#inFlight.get(lease.leaseId);
    if (existing !== undefined) {
      return existing;
    }

    const promise = this.#executeLease(lease, signal);
    this.#inFlight.set(lease.leaseId, promise);
    try {
      const result = await promise;
      this.#completed.set(lease.leaseId, result);
      return result;
    } finally {
      this.#inFlight.delete(lease.leaseId);
    }
  }

  async #executeLease(lease: AgentTaskLease, signal?: AbortSignal): Promise<AgentTaskResult> {
    this.#active += 1;
    const controller = new AbortController();
    this.#controllers.add(controller);
    const startedAt = this.#now().toISOString();
    const timeoutMs = Math.max(1, new Date(lease.expiresAt).getTime() - this.#now().getTime());
    const timeout = AbortSignal.timeout(timeoutMs);
    const combinedSignal =
      signal === undefined ? AbortSignal.any([controller.signal, timeout]) : AbortSignal.any([signal, controller.signal, timeout]);

    try {
      const manifest = this.#manifests.get(lease.agentId);
      if (manifest === undefined) {
        return this.#failure(lease, "VALIDATION_FAILED", "Unknown or unregistered agent id", startedAt);
      }
      if (manifest.model.tag !== lease.model.tag || manifest.model.digest !== lease.model.digest) {
        return this.#failure(lease, "VALIDATION_FAILED", "Lease model identity does not match registered manifest", startedAt);
      }
      if (manifest.health.status === "offline") {
        return this.#failure(lease, "UNAVAILABLE", "Registered agent is offline", startedAt);
      }

      const output = await this.#callModel(manifest, lease, combinedSignal);
      return AgentTaskResultSchema.parse({
        ...identityFromLease(lease),
        status: "succeeded",
        output,
        startedAt,
        completedAt: this.#now().toISOString(),
      });
    } catch (error) {
      const code: ResultErrorCode = combinedSignal.aborted ? (this.#stopped ? "CANCELLED" : "TIMEOUT") : "MODEL_ERROR";
      return this.#failure(lease, code, safeErrorMessage(error), startedAt);
    } finally {
      this.#controllers.delete(controller);
      this.#active -= 1;
    }
  }

  async #callModel(manifest: AgentManifest, lease: AgentTaskLease, signal: AbortSignal): Promise<string> {
    const messages: ChatMessage[] = [{ role: "user", content: lease.prompt }];
    const response =
      manifest.provider === "ollama"
        ? await this.#ollamaClient.chat({ model: manifest.model.tag, messages }, signal)
        : await this.#providerChat(manifest.provider, { model: manifest.model.tag, messages }, signal);

    return extractOutput(response);
  }

  async #providerChat(
    provider: ProviderName,
    request: { model: string; messages: ChatMessage[] },
    signal: AbortSignal,
  ): Promise<unknown> {
    const client = this.#providerClients[provider];
    if (client === undefined) {
      throw new Error(`Provider ${provider} is unavailable`);
    }

    return client.chat(request, signal);
  }

  #failure(lease: AgentTaskLease, code: ResultErrorCode, message: string, startedAt: string): AgentTaskResult {
    return AgentTaskResultSchema.parse({
      ...identityFromLease(lease),
      status: code === "CANCELLED" ? "cancelled" : "failed",
      error: { code, message },
      startedAt,
      completedAt: this.#now().toISOString(),
    });
  }

  #maxConcurrency(): number {
    let limit = 1;
    for (const manifest of this.#manifests.values()) {
      limit = Math.max(limit, manifest.limits.maxConcurrency);
    }
    return limit;
  }
}

function identityFromLease(lease: AgentTaskLease): Pick<
  AgentTaskResult,
  "taskId" | "requestId" | "runId" | "leaseId" | "agentId" | "model"
> {
  return {
    taskId: lease.taskId,
    requestId: lease.requestId,
    runId: lease.runId,
    leaseId: lease.leaseId,
    agentId: lease.agentId,
    model: lease.model,
  };
}

function extractOutput(response: unknown): string {
  if (isRecord(response)) {
    const message = response["message"];
    if (isRecord(message) && typeof message["content"] === "string") {
      return message["content"];
    }

    const choices = response["choices"];
    if (Array.isArray(choices)) {
      const first = choices[0];
      if (isRecord(first)) {
        const choiceMessage = first["message"];
        if (isRecord(choiceMessage) && typeof choiceMessage["content"] === "string") {
          return choiceMessage["content"];
        }
      }
    }
  }

  return JSON.stringify(response);
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message.slice(0, 240);
  }

  return "Model request failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
