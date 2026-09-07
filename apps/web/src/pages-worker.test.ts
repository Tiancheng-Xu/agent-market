import { describe, expect, it } from "vitest";

import { createPagesHandler, type PagesEnvironment } from "./pages-worker";

const template =
  '<!doctype html><html><body><div id="root"></div><script src="/assets/app.js"></script></body></html>';

function environment(): PagesEnvironment {
  return {
    ASSETS: {
      async fetch(request) {
        return new URL(request.url).pathname === "/index.html"
          ? new Response(template)
          : new Response("asset-not-found", { status: 404 });
      },
    },
  };
}

function stream(markup: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(markup));
      controller.close();
    },
  });
}

describe("Cloudflare Pages edge renderer", () => {
  it("serves the Cocos document from static assets instead of SSR", async () => {
    let renderCalls = 0;
    const handler = createPagesHandler({
      version: "test",
      async render() {
        renderCalls += 1;
        return stream("must-not-render");
      },
      logger: { info() {}, error() {} },
    });
    const response = await handler.fetch(new Request("https://market.example/office-cocos/index.html", {
      headers: { accept: "text/html" },
    }), {
      ASSETS: { async fetch() { return new Response("cocos-index"); } },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("cocos-index");
    expect(renderCalls).toBe(0);
  });

  it("renders known routes and preserves a real 404 status", async () => {
    const handler = createPagesHandler({
      version: "test",
      async render(pathname) {
        return stream(`<h1>${pathname}</h1>`);
      },
      logger: { info() {}, error() {} },
    });

    const office = await handler.fetch(new Request("https://market.example/office", {
      headers: { accept: "text/html" },
    }), environment());
    expect(office.status).toBe(200);
    expect(await office.text()).toContain("/office");

    const evidence = await handler.fetch(
      new Request("https://agent-market.test/evidence", {
        headers: { accept: "text/html" },
      }),
      environment(),
    );
    const missing = await handler.fetch(
      new Request("https://agent-market.test/missing", {
        headers: { accept: "text/html" },
      }),
      environment(),
    );

    expect(evidence.status).toBe(200);
    expect(evidence.headers.get("x-agent-market-render-mode")).toBe("ssr");
    expect(await evidence.text()).toContain('data-render-mode="ssr"');
    expect(missing.status).toBe(404);
  });

  it("preserves a real 404 for extensionless HTTP clients without an HTML accept header", async () => {
    const handler = createPagesHandler({
      version: "test",
      async render(pathname) {
        return stream(`<h1>${pathname}</h1>`);
      },
      logger: { info() {}, error() {} },
    });

    for (const headers of [undefined, { accept: "*/*" }]) {
      const request = headers
        ? new Request("https://agent-market.test/not-a-real-route", { headers })
        : new Request("https://agent-market.test/not-a-real-route");
      const response = await handler.fetch(
        request,
        environment(),
      );

      expect(response.status).toBe(404);
      expect(response.headers.get("x-agent-market-render-mode")).toBe("ssr");
      expect(await response.text()).toContain("not-a-real-route");
    }
  });

  it("falls back to CSR when edge rendering fails", async () => {
    const handler = createPagesHandler({
      version: "test",
      async render() {
        throw new Error("render failed");
      },
      logger: { info() {}, error() {} },
    });

    const response = await handler.fetch(
      new Request("https://agent-market.test/tasks", {
        headers: { accept: "text/html" },
      }),
      environment(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-agent-market-render-mode"))
      .toBe("csr-fallback");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toContain('data-render-mode="csr-fallback"');
  });

  it("reports live agent health as offline when no runtime is configured", async () => {
    const handler = createPagesHandler({ logger: { info() {}, error() {} } });

    const response = await handler.fetch(new Request("https://agent-market.test/agent/healthz"), environment());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: "offline", reasonCode: "RUNTIME_OFFLINE" });
    expect(JSON.stringify(body)).not.toContain("11434");
  });

  it("proxies allowlisted same-origin transaction requests and preserves secure cookies", async () => {
    const calls: Request[] = [];
    const handler = createPagesHandler({
      logger: { info() {}, error() {} },
      async upstreamFetch(input, init) {
        const request = new Request(input, init);
        calls.push(request);
        return Response.json({ task: { resourceId: "task" } }, { status: 201, headers: { "set-cookie": "__Host-agent_market_session=opaque; Secure; HttpOnly" } });
      },
    });
    const response = await handler.fetch(new Request("https://agent-market.test/api/tasks", {
      method: "POST",
      headers: { origin: "https://agent-market.test", "content-type": "application/json" },
      body: "{}",
    }), { ...environment(), TRANSACTION_ENGINE_ORIGIN: "https://transaction.internal" });

    expect(response.status).toBe(201);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(calls[0]?.url).toBe("https://transaction.internal/api/tasks");
    expect(calls[0]?.headers.get("x-forwarded-host")).toBe("agent-market.test");
    expect(calls[0]?.headers.get("authorization")).toBeNull();
  });

  it("fails closed when the transaction engine is not configured", async () => {
    const handler = createPagesHandler({ logger: { info() {}, error() {} } });
    const response = await handler.fetch(new Request("https://agent-market.test/api/tasks", {
      method: "POST",
      headers: { origin: "https://agent-market.test", "content-type": "application/json" },
      body: "{}",
    }), environment());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: "TRANSACTION_ENGINE_OFFLINE" });
  });

  it("proxies only the allowlisted public reputation GET without forwarding cookies", async () => {
    const calls: Request[] = [];
    const handler = createPagesHandler({
      logger: { info() {}, error() {} },
      async upstreamFetch(input, init) {
        const request = new Request(input, init);
        calls.push(request);
        return Response.json({ reputation: {}, requestId: "7dc42790-a91c-4d62-9d5d-a08bb5211141" });
      },
    });
    const agentId = "7dc42790-a91c-4d62-9d5d-a08bb5211141";
    const response = await handler.fetch(new Request(`https://agent-market.test/api/agents/${agentId}/reputation`, {
      headers: { cookie: "__Host-agent_market_session=opaque" },
    }), { ...environment(), TRANSACTION_ENGINE_ORIGIN: "https://transaction.internal" });

    expect(response.status).toBe(200);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.headers.get("cookie")).toBeNull();
    expect(calls[0]?.url).toBe(`https://transaction.internal/api/agents/${agentId}/reputation`);
  });

  it("rejects unsupported methods on dynamic transaction routes", async () => {
    const taskId = "7dc42790-a91c-4d62-9d5d-a08bb5211141";
    const handler = createPagesHandler({ logger: { info() {}, error() {} } });
    const response = await handler.fetch(new Request(`https://agent-market.test/api/tasks/${taskId}/risk-quote`), environment());
    expect(response.status).toBe(405);
  });

  it("proxies authenticated risk-context GET with the session cookie intact", async () => {
    const calls: Request[] = [];
    const handler = createPagesHandler({
      logger: { info() {}, error() {} },
      async upstreamFetch(input, init) {
        const request = new Request(input, init);
        calls.push(request);
        return Response.json({ taskId: "safe" }, { headers: { "cache-control": "no-store" } });
      },
    });
    const taskId = "7dc42790-a91c-4d62-9d5d-a08bb5211141";
    const response = await handler.fetch(new Request(
      `https://agent-market.test/api/tasks/${taskId}/risk-context`,
      { headers: { cookie: "__Host-agent_market_session=opaque" } },
    ), { ...environment(), TRANSACTION_ENGINE_ORIGIN: "https://transaction.internal" });

    expect(response.status).toBe(200);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.headers.get("cookie")).toBe("__Host-agent_market_session=opaque");
    expect(calls[0]?.url).toBe(`https://transaction.internal/api/tasks/${taskId}/risk-context`);
  });

  it("proxies the exact authenticated order GET without requiring Origin and preserves its cookie", async () => {
    const calls: Request[] = [];
    const handler = createPagesHandler({
      logger: { info() {}, error() {} },
      async upstreamFetch(input, init) {
        const request = new Request(input, init);
        calls.push(request);
        return Response.json({ order: { orderId: "7dc42790-a91c-4d62-9d5d-a08bb5211141" } });
      },
    });
    const orderId = "7dc42790-a91c-4d62-9d5d-a08bb5211141";
    const response = await handler.fetch(new Request(`https://agent-market.test/api/orders/${orderId}`, {
      headers: { cookie: "__Host-agent_market_session=opaque" },
    }), { ...environment(), TRANSACTION_ENGINE_ORIGIN: "https://transaction.internal" });

    expect(response.status).toBe(200);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.headers.get("cookie")).toBe("__Host-agent_market_session=opaque");
    expect(calls[0]?.url).toBe(`https://transaction.internal/api/orders/${orderId}`);
  });

  it("proxies exact same-origin order commands and rejects wrong origins", async () => {
    const calls: Request[] = [];
    const handler = createPagesHandler({
      logger: { info() {}, error() {} },
      async upstreamFetch(input, init) {
        calls.push(new Request(input, init));
        return Response.json({ order: { status: "accepted" } });
      },
    });
    const orderId = "7dc42790-a91c-4d62-9d5d-a08bb5211141";
    const environmentWithEngine = { ...environment(), TRANSACTION_ENGINE_ORIGIN: "https://transaction.internal" };
    const accepted = await handler.fetch(new Request(`https://agent-market.test/api/orders/${orderId}/commands`, {
      method: "POST",
      headers: { origin: "https://agent-market.test", cookie: "__Host-agent_market_session=opaque", "content-type": "application/json" },
      body: JSON.stringify({ command: "accept" }),
    }), environmentWithEngine);
    const rejected = await handler.fetch(new Request(`https://agent-market.test/api/orders/${orderId}/commands`, {
      method: "POST",
      headers: { origin: "https://attacker.test", "content-type": "application/json" },
      body: JSON.stringify({ command: "accept" }),
    }), environmentWithEngine);

    expect(accepted.status).toBe(200);
    expect(calls[0]?.headers.get("cookie")).toBe("__Host-agent_market_session=opaque");
    expect(calls[0]?.url).toBe(`https://transaction.internal/api/orders/${orderId}/commands`);
    expect(rejected.status).toBe(403);
    expect(calls).toHaveLength(1);
  });

  it("returns 405 for unsupported exact order methods and 404 for unknown order paths", async () => {
    const handler = createPagesHandler({ logger: { info() {}, error() {} } });
    const orderId = "7dc42790-a91c-4d62-9d5d-a08bb5211141";
    const unsupported = await handler.fetch(new Request(`https://agent-market.test/api/orders/${orderId}`, {
      method: "POST",
      headers: { origin: "https://agent-market.test" },
    }), environment());
    const unknown = await handler.fetch(new Request(`https://agent-market.test/api/orders/${orderId}/unknown`, {
      headers: { accept: "application/json" },
    }), environment());

    expect(unsupported.status).toBe(405);
    expect(unknown.status).toBe(404);
  });

  it("serves a public-safe agent catalog contract", async () => {
    const handler = createPagesHandler({ logger: { info() {}, error() {} } });

    const response = await handler.fetch(new Request("https://agent-market.test/agent/catalog"), environment());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-agent-market-catalog-version")).toBe("agent-market.catalog.v1");
    expect(body.endpoints).toMatchObject({ catalog: "/agent/catalog", health: "/agent/healthz" });
    expect(body.types.sharedContract).toBe("packages/shared-contracts/src/local-agent.ts");
    expect(body.agents.some((agent: { id: string }) => agent.id === "kimi-kimi-k2-7-code")).toBe(true);
    expect(JSON.stringify(body)).not.toContain("API_KEY");
    expect(JSON.stringify(body)).not.toContain("secret-value");
    expect(JSON.stringify(body)).not.toContain("11434");
  });

  it("proxies signed live chat requests as SSE", async () => {
    const calls: Request[] = [];
    const handler = createPagesHandler({
      logger: { info() {}, error() {} },
      async upstreamFetch(input, init) {
        const request = new Request(input, init);
        calls.push(request);
        return new Response('event: delta\ndata: {"event":"delta","requestId":"11111111-1111-4111-8111-111111111111","delta":"ok"}\n\n', {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    const response = await handler.fetch(new Request("https://agent-market.test/agent/chat", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://agent-market.test" },
      body: JSON.stringify({
        requestId: "11111111-1111-4111-8111-111111111111",
        agentId: "deepseek-deepseek-v4-flash",
        messages: [{ role: "user", content: "hi" }],
      }),
    }), {
      ...environment(),
      AGENT_RUNTIME_ORIGIN: "https://runtime.agent-market.test",
      AGENT_RUNTIME_SHARED_SECRET: "runtime-secret",
    });

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(calls[0]?.headers.get("x-agent-caller-scope")).toBe("public");
    expect(calls[0]?.headers.get("x-agent-signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(await response.text()).toContain("ok");
  });

  it("proxies signed GraphQL orchestration requests to the runtime resolver", async () => {
    const calls: Request[] = [];
    const handler = createPagesHandler({
      logger: { info() {}, error() {} },
      async upstreamFetch(input, init) {
        const request = new Request(input, init);
        calls.push(request);
        return Response.json({
          data: {
            orchestrateAgents: {
              requestId: "11111111-1111-4111-8111-111111111111",
              runId: "22222222-2222-4222-8222-222222222222",
              status: "succeeded",
              leadAgentId: "personal-ai-agent-runtime-v4-1",
              steps: [],
              finalOutput: "lead synthesis",
            },
          },
        });
      },
    });

    const response = await handler.fetch(new Request("https://agent-market.test/agent/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://agent-market.test" },
      body: JSON.stringify({
        query: "mutation OrchestrateAgents($input: AgentOrchestrationInput!) { orchestrateAgents(input: $input) { finalOutput } }",
        operationName: "OrchestrateAgents",
        variables: {
          input: {
            requestId: "11111111-1111-4111-8111-111111111111",
            agentIds: ["personal-ai-agent-runtime-v4-1", "deepseek-deepseek-v4-flash"],
            messages: [{ role: "user", content: "compare two answers" }],
          },
        },
      }),
    }), {
      ...environment(),
      AGENT_RUNTIME_ORIGIN: "https://runtime.agent-market.test",
      AGENT_RUNTIME_SHARED_SECRET: "runtime-secret",
    });
    const payload = await response.json();

    expect(response.headers.get("content-type")).toContain("application/json");
    expect(new URL(calls[0]?.url ?? "https://missing.test").pathname).toBe("/graphql");
    expect(calls[0]?.headers.get("x-agent-caller-scope")).toBe("public");
    expect(calls[0]?.headers.get("x-agent-signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(payload).toMatchObject({
      data: {
        orchestrateAgents: {
          status: "succeeded",
          finalOutput: "lead synthesis",
        },
      },
    });
  });

  it("validates and signs Queen GraphQL state-machine mutations to runtime /graphql", async () => {
    const calls: Request[] = [];
    const handler = createPagesHandler({
      logger: { info() {}, error() {} },
      async upstreamFetch(input, init) {
        const request = new Request(input, init);
        calls.push(request);
        return Response.json({
          data: {
            proposeTaskGraph: {
              taskId: "11111111-1111-4111-8111-111111111111",
              graphRevision: 1,
              rescuePolicy: { mode: "auto", visibleToUser: false, evidenceVisible: true },
            },
          },
        });
      },
    });

    const response = await handler.fetch(new Request("https://agent-market.test/agent/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://agent-market.test" },
      body: JSON.stringify({
        query: "mutation ProposeTaskGraph($input: ProposeTaskGraphInput!) { proposeTaskGraph(input: $input) { taskId } }",
        operationName: "ProposeTaskGraph",
        variables: {
          input: {
            requirement: "Build a verified Queen-led workflow",
            queenAgentId: "queen-router-v1",
          },
        },
      }),
    }), {
      ...environment(),
      AGENT_RUNTIME_ORIGIN: "https://runtime.agent-market.test",
      AGENT_RUNTIME_SHARED_SECRET: "runtime-secret",
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(new URL(calls[0]?.url ?? "https://missing.test").pathname).toBe("/graphql");
    expect(calls[0]?.headers.get("x-agent-signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.data.proposeTaskGraph.rescuePolicy).toMatchObject({ mode: "auto", visibleToUser: false });
  });

  it("overrides a forged owner callerScope on the public GraphQL boundary", async () => {
    const calls: Request[] = [];
    const handler = createPagesHandler({
      logger: { info() {}, error() {} },
      async upstreamFetch(input, init) {
        calls.push(new Request(input, init));
        return Response.json({ data: { rankNodeAgents: { candidates: [] } } });
      },
    });
    const response = await handler.fetch(new Request("https://agent-market.test/agent/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://agent-market.test" },
      body: JSON.stringify({
        query: "mutation RankNodeAgents($input: RankNodeAgentsInput!) { rankNodeAgents(input: $input) { candidates { agentId } } }",
        operationName: "RankNodeAgents",
        variables: { input: { taskId: "11111111-1111-4111-8111-111111111111", nodeId: "execute-1", callerScope: "owner" } },
      }),
    }), {
      ...environment(),
      AGENT_RUNTIME_ORIGIN: "https://runtime.agent-market.test",
      AGENT_RUNTIME_SHARED_SECRET: "runtime-secret",
    });
    const forwarded = await calls[0]!.json() as { variables: { input: { callerScope: string } } };

    expect(response.status).toBe(200);
    expect(calls[0]?.headers.get("x-agent-caller-scope")).toBe("public");
    expect(forwarded.variables.input.callerScope).toBe("public");
  });

  it("returns GraphQL errors for Queen mutations when runtime is offline", async () => {
    const handler = createPagesHandler({ logger: { info() {}, error() {} } });

    const response = await handler.fetch(new Request("https://agent-market.test/agent/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://agent-market.test" },
      body: JSON.stringify({
        query: "mutation ProposeTaskGraph($input: ProposeTaskGraphInput!) { proposeTaskGraph(input: $input) { taskId } }",
        operationName: "ProposeTaskGraph",
        variables: { input: { requirement: "Build workflow", queenAgentId: "queen-router-v1" } },
      }),
    }), environment());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.errors[0].extensions.code).toBe("RUNTIME_OFFLINE");
  });
});
