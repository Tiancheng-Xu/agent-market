import {
  AgentManifestSchema,
  AgentTaskLeaseSchema,
  AgentTaskResultSchema,
  type AgentManifest,
  type AgentTaskLease,
  type AgentTaskResult,
} from "@agent-market/shared-contracts";

import { signedHeaders, signRequest, type SigningKey } from "./signing";

export type ControlPlaneFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ControlPlaneClientOptions = {
  origin: string;
  signingKey: SigningKey;
  fetchLike?: ControlPlaneFetch;
  now?: () => Date;
  nonce?: () => string;
};

export class ControlPlaneClient {
  readonly #origin: string;
  readonly #signingKey: SigningKey;
  readonly #fetch: ControlPlaneFetch;
  readonly #now: (() => Date) | undefined;
  readonly #nonce: (() => string) | undefined;

  constructor(options: ControlPlaneClientOptions) {
    this.#origin = options.origin.replace(/\/$/, "");
    this.#signingKey = options.signingKey;
    this.#fetch = options.fetchLike ?? fetch;
    this.#now = options.now;
    this.#nonce = options.nonce;
  }

  async registerManifests(manifests: AgentManifest[], signal?: AbortSignal): Promise<void> {
    for (const manifest of manifests) {
      AgentManifestSchema.parse(manifest);
    }

    await this.#jsonRequest("POST", "/agents/register", { manifests }, signal);
  }

  async heartbeat(agentIds: string[], signal?: AbortSignal): Promise<void> {
    await this.#jsonRequest("POST", "/agents/heartbeat", { agentIds, at: new Date().toISOString() }, signal);
  }

  async nextLease(signal?: AbortSignal): Promise<AgentTaskLease | undefined> {
    const payload = await this.#jsonRequest("GET", "/leases/next", undefined, signal);
    if (payload === null || payload === undefined) {
      return undefined;
    }

    return AgentTaskLeaseSchema.parse(payload);
  }

  async submitResult(result: AgentTaskResult, signal?: AbortSignal): Promise<void> {
    AgentTaskResultSchema.parse(result);
    await this.#jsonRequest("POST", `/leases/${result.leaseId}/result`, result, signal);
  }

  async #jsonRequest(method: "GET" | "POST", path: string, payload?: unknown, signal?: AbortSignal): Promise<unknown> {
    const body = payload === undefined ? "" : JSON.stringify(payload);
    const signature = signRequest(method, path, body, signingOptions(this.#signingKey, this.#now, this.#nonce));
    const init: RequestInit = {
      method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...signedHeaders(signature),
      },
    };
    if (signal !== undefined) {
      init.signal = signal;
    }
    if (method !== "GET") {
      init.body = body;
    }

    const response = await this.#fetch(`${this.#origin}${path}`, init);

    if (!response.ok) {
      throw new Error(`Control plane request failed with status ${response.status}`);
    }

    if (response.status === 204) {
      return undefined;
    }

    return response.json();
  }
}

function signingOptions(key: SigningKey, now: (() => Date) | undefined, nonce: (() => string) | undefined) {
  return {
    key,
    ...(now === undefined ? {} : { now }),
    ...(nonce === undefined ? {} : { nonce }),
  };
}
