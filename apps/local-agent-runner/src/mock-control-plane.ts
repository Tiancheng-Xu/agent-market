import {
  AgentManifestSchema,
  AgentTaskLeaseSchema,
  AgentTaskResultSchema,
  type AgentManifest,
  type AgentTaskLease,
  type AgentTaskResult,
} from "@agent-market/shared-contracts";

import { NonceReplayStore, verifySignedRequest, type SigningKey } from "./signing";

export class MockControlPlane {
  readonly manifests: AgentManifest[] = [];
  readonly heartbeats: string[][] = [];
  readonly results: AgentTaskResult[] = [];
  readonly #leases: AgentTaskLease[] = [];
  readonly #keys: Map<string, string>;
  readonly #nonceStore = new NonceReplayStore();
  readonly #now: () => Date;
  offline = false;

  constructor(options: { signingKey: SigningKey; leases?: AgentTaskLease[]; now?: () => Date }) {
    this.#keys = new Map([[options.signingKey.keyId, options.signingKey.secret]]);
    this.#leases.push(...(options.leases ?? []));
    this.#now = options.now ?? (() => new Date());
  }

  enqueueLease(lease: AgentTaskLease): void {
    this.#leases.push(AgentTaskLeaseSchema.parse(lease));
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (this.offline) {
      return Response.json({ error: "offline" }, { status: 503 });
    }

    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = await request.text();
    const verified = verifySignedRequest(request.method, url.pathname, body, request.headers, {
      keys: this.#keys,
      now: this.#now,
      nonceStore: this.#nonceStore,
    });

    if (!verified.ok) {
      return Response.json({ error: verified.reason }, { status: 401 });
    }

    if (request.method === "POST" && url.pathname === "/agents/register") {
      const payload = parseJson<{ manifests?: unknown[] }>(body);
      const manifests = payload.manifests?.map((manifest) => AgentManifestSchema.parse(manifest)) ?? [];
      this.manifests.push(...manifests);
      return Response.json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/agents/heartbeat") {
      const payload = parseJson<{ agentIds?: string[] }>(body);
      this.heartbeats.push(payload.agentIds ?? []);
      return Response.json({ ok: true });
    }

    if (request.method === "GET" && url.pathname === "/leases/next") {
      return Response.json(this.#leases.shift() ?? null);
    }

    if (request.method === "POST" && /^\/leases\/[^/]+\/result$/.test(url.pathname)) {
      const result = AgentTaskResultSchema.parse(parseJson<unknown>(body));
      this.results.push(result);
      return Response.json({ ok: true });
    }

    return Response.json({ error: "not found" }, { status: 404 });
  };
}

function parseJson<T>(body: string): T {
  return JSON.parse(body) as T;
}
