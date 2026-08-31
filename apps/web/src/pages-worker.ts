import { renderRouteStream } from "./entry-server";
import { publicAgentCatalogResponse } from "./agentCatalog";
import {
  LiveAgentGraphqlRequestSchema,
  LiveChatErrorSchema,
  LiveChatHealthSchema,
  LiveChatRequestSchema,
  QueenGraphqlRequestSchema,
  type LiveChatError,
} from "@agent-market/shared-contracts";
import { buildCsrFallbackDocument, composeSsrDocument } from "./ssr/html";
import type { RenderState } from "./ssr/renderState";
import { routeForPath } from "./ssr/routeDefinitions";

export interface PagesEnvironment {
  ASSETS: { fetch(request: Request): Promise<Response> };
  API_ORIGIN?: string;
  PERFORMANCE_HMAC_SECRET?: string;
  TRANSACTION_ENGINE_ORIGIN?: string;
  AGENT_ALLOWED_ORIGINS?: string;
  AGENT_CHAT_MAX_BYTES?: string;
  AGENT_RUNTIME_KEY_ID?: string;
  AGENT_RUNTIME_ORIGIN?: string;
  AGENT_RUNTIME_SHARED_SECRET?: string;
  TURNSTILE_SECRET?: string;
}

const TRANSACTION_ENGINE_PATHS = new Set([
  "/api/auth/challenge",
  "/api/auth/verify",
  "/api/auth/logout",
  "/api/tasks",
  "/api/chain/account",
  "/api/chain/position",
  "/api/transactions/intents",
  "/api/transactions/verify",
]);

async function proxyTransactionEngine(request: Request, environment: PagesEnvironment, upstreamFetch: typeof fetch): Promise<Response> {
  if (request.method !== "POST") return Response.json({ error: "METHOD_NOT_ALLOWED" }, { status: 405 });
  const requestUrl = new URL(request.url);
  if (request.headers.get("origin") !== requestUrl.origin) {
    return Response.json({ error: "AUTH_ORIGIN_MISMATCH" }, { status: 403 });
  }
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(contentLength) || contentLength > 32_768) {
    return Response.json({ error: "PAYLOAD_TOO_LARGE" }, { status: 413 });
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > 32_768) {
    return Response.json({ error: "PAYLOAD_TOO_LARGE" }, { status: 413 });
  }
  if (!environment.TRANSACTION_ENGINE_ORIGIN) {
    return Response.json({ error: "TRANSACTION_ENGINE_OFFLINE" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
  const origin = environment.TRANSACTION_ENGINE_ORIGIN.endsWith("/")
    ? environment.TRANSACTION_ENGINE_ORIGIN
    : `${environment.TRANSACTION_ENGINE_ORIGIN}/`;
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("x-forwarded-host");
  headers.delete("x-forwarded-proto");
  headers.set("x-forwarded-host", requestUrl.host);
  headers.set("x-forwarded-proto", requestUrl.protocol.slice(0, -1));
  const upstream = await upstreamFetch(new Request(new URL(requestUrl.pathname.slice(1), origin), {
    method: "POST",
    headers,
    body,
    redirect: "manual",
  }));
  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.delete("server");
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

type RenderRoute = (
  pathname: string,
  signal: AbortSignal,
) => Promise<ReadableStream<Uint8Array>>;

interface HandlerOptions {
  render?: RenderRoute;
  timeoutMs?: number;
  version?: string;
  now?: () => number;
  logger?: Pick<Console, "info" | "error">;
  upstreamFetch?: typeof fetch;
}

const securityHeaders = {
  "content-security-policy": "base-uri 'self'; object-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

const AGENT_CHAT_DEFAULT_MAX_BYTES = 16_384;
const AGENT_RUNTIME_KEY_ID = "edge-runtime-v1";
const signedHeaderNames = {
  keyId: "x-agent-key-id",
  timestamp: "x-agent-timestamp",
  nonce: "x-agent-nonce",
  bodySha256: "x-agent-body-sha256",
  signature: "x-agent-signature",
} as const;

async function performanceHmacSha256Hex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(signature)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function isDocumentRequest(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const pathname = new URL(request.url).pathname;
  if (pathname.startsWith("/assets/") || /\.[a-z0-9]+$/i.test(pathname)) {
    return false;
  }
  const accept = request.headers.get("accept")?.trim();
  return accept === undefined || accept === "*/*" || accept.includes("text/html");
}

function documentHeaders(mode: "ssr" | "csr-fallback", cache: string) {
  return new Headers({
    ...securityHeaders,
    "cache-control": cache,
    "content-type": "text/html; charset=utf-8",
    vary: "Accept",
    "x-agent-market-render-mode": mode,
  });
}

async function loadTemplate(request: Request, environment: PagesEnvironment) {
  return environment.ASSETS.fetch(new Request(
    new URL("/index.html", request.url),
    { headers: { accept: "text/html" } },
  ));
}

async function renderWithTimeout(
  render: RenderRoute,
  pathname: string,
  timeoutMs: number,
): Promise<Uint8Array> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const rendering = (async () => {
    const stream = await render(pathname, controller.signal);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  })();
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error("SSR_TIMEOUT"));
    }, timeoutMs);
  });

  try {
    return await Promise.race([rendering, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function completedStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

export function createPagesHandler(options: HandlerOptions = {}) {
  const render = options.render ?? renderRouteStream;
  const timeoutMs = options.timeoutMs ?? 2_500;
  const version = options.version ?? import.meta.env.VITE_APP_VERSION ?? "unknown";
  const now = options.now ?? Date.now;
  const logger = options.logger ?? console;
  const upstreamFetch = options.upstreamFetch ?? fetch;

  return {
    async fetch(request: Request, environment: PagesEnvironment): Promise<Response> {
      const requestUrl = new URL(request.url);
      if (requestUrl.pathname === "/agent/healthz") {
        return handleAgentHealth(request, environment, upstreamFetch);
      }
      if (requestUrl.pathname === "/agent/catalog") {
        return handleAgentCatalog(request, environment);
      }
      if (requestUrl.pathname === "/agent/chat" || (requestUrl.pathname === "/agent/chat" && request.method === "OPTIONS")) {
        return handleAgentChat(request, environment, upstreamFetch);
      }
      if (requestUrl.pathname === "/agent/graphql") {
        return handleAgentGraphql(request, environment, upstreamFetch);
      }

      if (TRANSACTION_ENGINE_PATHS.has(requestUrl.pathname)) {
        return proxyTransactionEngine(request, environment, upstreamFetch);
      }

      if (requestUrl.pathname === "/api/performance") {
        if (request.method !== "POST") {
          return Response.json({ error: "METHOD_NOT_ALLOWED" }, { status: 405 });
        }
        if (!environment.API_ORIGIN) {
          return Response.json({ error: "PERFORMANCE_ORIGIN_UNAVAILABLE" }, {
            status: 503,
          });
        }
        if (
          !environment.PERFORMANCE_HMAC_SECRET
          || environment.PERFORMANCE_HMAC_SECRET.length < 32
        ) {
          return Response.json({ error: "PERFORMANCE_AUTH_UNAVAILABLE" }, {
            status: 503,
          });
        }

        const origin = environment.API_ORIGIN.endsWith("/")
          ? environment.API_ORIGIN
          : `${environment.API_ORIGIN}/`;
        const body = await request.text();
        const timestamp = Math.floor(now() / 1_000).toString();
        const signature = await performanceHmacSha256Hex(
          environment.PERFORMANCE_HMAC_SECRET,
          `${timestamp}.${body}`,
        );
        const headers = new Headers(request.headers);
        headers.delete("authorization");
        headers.delete("cookie");
        headers.set("x-agent-market-timestamp", timestamp);
        headers.set("x-agent-market-signature", signature);
        const upstreamRequest = new Request(new URL("performance", origin), {
          method: "POST",
          headers,
          body,
          redirect: "manual",
        });
        return upstreamFetch(upstreamRequest);
      }

      const pathname = new URL(request.url).pathname;
      if (pathname === "/office-cocos" || pathname.startsWith("/office-cocos/")) {
        return environment.ASSETS.fetch(request);
      }
      if (!isDocumentRequest(request)) return environment.ASSETS.fetch(request);

      const startedAt = now();
      const status = routeForPath(pathname) ? 200 : 404;
      const templateResponse = await loadTemplate(request, environment);
      if (!templateResponse.ok) return templateResponse;
      const template = await templateResponse.text();
      const state: RenderState = { mode: "ssr", pathname, version };

      try {
        const app = await renderWithTimeout(render, pathname, timeoutMs);
        logger.info(JSON.stringify({
          event: "render.complete",
          mode: "ssr",
          pathname,
          status,
          durationMs: now() - startedAt,
        }));
        return new Response(
          request.method === "HEAD"
            ? null
            : composeSsrDocument(template, completedStream(app), state),
          {
            status,
            headers: documentHeaders(
              "ssr",
              status === 404 || request.headers.has("cookie")
                ? "private, no-store"
                : "public, max-age=0, must-revalidate",
            ),
          },
        );
      } catch (error) {
        logger.error(JSON.stringify({
          event: "render.fallback",
          mode: "csr-fallback",
          pathname,
          reason: error instanceof Error ? error.message : "render-error",
          durationMs: now() - startedAt,
        }));
        return new Response(
          request.method === "HEAD" ? null : buildCsrFallbackDocument(template, {
            ...state,
            mode: "csr-fallback",
          }),
          {
            status,
            headers: documentHeaders("csr-fallback", "no-store"),
          },
        );
      }
    },
  };
}

async function handleAgentGraphql(
  request: Request,
  environment: PagesEnvironment,
  upstreamFetch: typeof fetch,
): Promise<Response> {
  const cors = corsHeaders(request, environment);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  if (request.method !== "POST") {
    return jsonAgentError("VALIDATION_FAILED", "POST is required", undefined, false, 405, cors);
  }
  if (!isOriginAllowed(request, environment)) {
    return jsonAgentError("FORBIDDEN", "Origin is not allowed", undefined, false, 403, cors);
  }

  const maxBytes = parseMaxBytes(environment.AGENT_CHAT_MAX_BYTES);
  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > maxBytes) {
    return jsonAgentError("REQUEST_TOO_LARGE", "GraphQL request is too large", undefined, false, 413, cors);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(rawBody);
  } catch {
    return jsonAgentError("VALIDATION_FAILED", "GraphQL request shape is invalid", undefined, false, 400, cors);
  }
  const queenRequest = QueenGraphqlRequestSchema.safeParse(raw);
  const liveRequest = LiveAgentGraphqlRequestSchema.safeParse(raw);
  const parsed = queenRequest.success && isQueenGraphqlOperation(queenRequest.data)
    ? normalizeGraphqlRequest(queenRequest.data)
    : liveRequest.success && /\borchestrateAgents\b/.test(liveRequest.data.query)
      ? normalizeGraphqlRequest(liveRequest.data)
      : undefined;
  if (parsed === undefined) {
    return jsonAgentError("VALIDATION_FAILED", "Only Agent Market GraphQL mutations are supported", undefined, false, 400, cors);
  }

  const requestId = typeof parsed.variables.input["requestId"] === "string"
    ? parsed.variables.input["requestId"]
    : crypto.randomUUID();
  const runtimeBody = JSON.stringify({
    ...parsed,
    variables: {
      ...parsed.variables,
      input: { ...parsed.variables.input, requestId },
    },
  });

  if (environment.TURNSTILE_SECRET) {
    const turnstileToken = typeof parsed.variables.input["turnstileToken"] === "string"
      ? parsed.variables.input["turnstileToken"]
      : undefined;
    const turnstile = await verifyTurnstile(turnstileToken, environment.TURNSTILE_SECRET, upstreamFetch);
    if (!turnstile) {
      return jsonAgentError("TURNSTILE_FAILED", "Human verification failed", requestId, true, 403, cors);
    }
  }

  if (!environment.AGENT_RUNTIME_ORIGIN || !environment.AGENT_RUNTIME_SHARED_SECRET) {
    return graphqlAgentError("RUNTIME_OFFLINE", "Agent runtime is not configured", requestId, true, cors);
  }

  try {
    const headers = await signRuntimeHeaders(
      "POST",
      "/graphql",
      runtimeBody,
      environment.AGENT_RUNTIME_SHARED_SECRET,
      environment.AGENT_RUNTIME_KEY_ID ?? AGENT_RUNTIME_KEY_ID,
    );
    const upstream = await upstreamFetch(new Request(new URL("/graphql", normalizedOrigin(environment.AGENT_RUNTIME_ORIGIN)), {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-caller-scope": "public", ...headers },
      body: runtimeBody,
      signal: AbortSignal.timeout(120_000),
    }));
    if (!upstream.ok || upstream.body === null) {
      return graphqlAgentError("RUNTIME_OFFLINE", "Agent runtime is offline", requestId, true, cors);
    }
    return new Response(upstream.body, {
      status: 200,
      headers: { ...agentJsonHeaders(), ...cors },
    });
  } catch {
    return graphqlAgentError("UPSTREAM_TIMEOUT", "Agent runtime did not respond in time", requestId, true, cors);
  }
}

export default createPagesHandler();

function handleAgentCatalog(request: Request, environment: PagesEnvironment): Response {
  const cors = corsHeaders(request, environment);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonAgentError("VALIDATION_FAILED", "GET is required", undefined, false, 405, cors);
  }
  return Response.json(publicAgentCatalogResponse, {
    headers: {
      ...agentJsonHeaders(),
      ...cors,
      "x-agent-market-catalog-version": publicAgentCatalogResponse.schemaVersion,
    },
  });
}

async function handleAgentHealth(
  request: Request,
  environment: PagesEnvironment,
  upstreamFetch: typeof fetch,
): Promise<Response> {
  const requestUrl = new URL(request.url);
  const cors = corsHeaders(request, environment);
  if (!environment.AGENT_RUNTIME_ORIGIN || !environment.AGENT_RUNTIME_SHARED_SECRET) {
    return Response.json(LiveChatHealthSchema.parse({
      status: "offline",
      checkedAt: new Date().toISOString(),
      runtime: "edge",
      reasonCode: "RUNTIME_OFFLINE",
      agents: [],
    }), { headers: { ...agentJsonHeaders(), ...cors } });
  }

  try {
    const body = "";
    const headers = await signRuntimeHeaders(
      "GET",
      "/healthz",
      body,
      environment.AGENT_RUNTIME_SHARED_SECRET,
      environment.AGENT_RUNTIME_KEY_ID ?? AGENT_RUNTIME_KEY_ID,
    );
    const response = await upstreamFetch(new Request(new URL("/healthz", normalizedOrigin(environment.AGENT_RUNTIME_ORIGIN)), {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(3_000),
    }));
    if (!response.ok) throw new Error("runtime health failed");
    return new Response(response.body, {
      status: response.status,
      headers: { ...agentJsonHeaders(), ...cors },
    });
  } catch {
    return Response.json({
      status: "offline",
      checkedAt: new Date().toISOString(),
      runtime: "edge",
      reasonCode: "RUNTIME_OFFLINE",
      agents: [],
    }, { headers: { ...agentJsonHeaders(), ...cors } });
  }
}

async function handleAgentChat(
  request: Request,
  environment: PagesEnvironment,
  upstreamFetch: typeof fetch,
): Promise<Response> {
  const cors = corsHeaders(request, environment);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  if (request.method !== "POST") {
    return jsonAgentError("VALIDATION_FAILED", "POST is required", undefined, false, 405, cors);
  }
  if (!isOriginAllowed(request, environment)) {
    return jsonAgentError("FORBIDDEN", "Origin is not allowed", undefined, false, 403, cors);
  }

  const maxBytes = parseMaxBytes(environment.AGENT_CHAT_MAX_BYTES);
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return jsonAgentError("REQUEST_TOO_LARGE", "Chat request is too large", undefined, false, 413, cors);
  }

  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > maxBytes) {
    return jsonAgentError("REQUEST_TOO_LARGE", "Chat request is too large", undefined, false, 413, cors);
  }

  let parsed: ReturnType<typeof LiveChatRequestSchema.parse>;
  try {
    parsed = LiveChatRequestSchema.parse(JSON.parse(rawBody));
  } catch {
    return jsonAgentError("VALIDATION_FAILED", "Chat request shape is invalid", undefined, false, 400, cors);
  }

  const requestId = parsed.requestId ?? crypto.randomUUID();
  const runtimeBody = JSON.stringify({ ...parsed, requestId });

  if (environment.TURNSTILE_SECRET) {
    const turnstile = await verifyTurnstile(parsed.turnstileToken, environment.TURNSTILE_SECRET, upstreamFetch);
    if (!turnstile) {
      return jsonAgentError("TURNSTILE_FAILED", "Human verification failed", requestId, true, 403, cors);
    }
  }

  if (!environment.AGENT_RUNTIME_ORIGIN || !environment.AGENT_RUNTIME_SHARED_SECRET) {
    return sseAgentError("RUNTIME_OFFLINE", "Agent runtime is not configured", requestId, true, cors);
  }

  try {
    const headers = await signRuntimeHeaders(
      "POST",
      "/agent/chat",
      runtimeBody,
      environment.AGENT_RUNTIME_SHARED_SECRET,
      environment.AGENT_RUNTIME_KEY_ID ?? AGENT_RUNTIME_KEY_ID,
    );
    const upstream = await upstreamFetch(new Request(new URL("/agent/chat", normalizedOrigin(environment.AGENT_RUNTIME_ORIGIN)), {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-caller-scope": "public", ...headers },
      body: runtimeBody,
      signal: AbortSignal.timeout(120_000),
    }));
    if (!upstream.ok || upstream.body === null) {
      return sseAgentError("RUNTIME_OFFLINE", "Agent runtime is offline", requestId, true, cors);
    }
    return new Response(upstream.body, {
      status: 200,
      headers: {
        ...cors,
        "cache-control": "no-store",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
      },
    });
  } catch {
    return sseAgentError("UPSTREAM_TIMEOUT", "Agent runtime did not respond in time", requestId, true, cors);
  }
}

function corsHeaders(request: Request, environment: PagesEnvironment): Record<string, string> {
  const origin = request.headers.get("origin");
  const allowedOrigin = origin && isOriginAllowed(request, environment) ? origin : new URL(request.url).origin;
  return {
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-origin": allowedOrigin,
    "vary": "Origin",
  };
}

function isOriginAllowed(request: Request, environment: PagesEnvironment): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const requestOrigin = new URL(request.url).origin;
  const configured = (environment.AGENT_ALLOWED_ORIGINS ?? requestOrigin)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return origin === requestOrigin || configured.includes(origin);
}

function agentJsonHeaders(): Record<string, string> {
  return { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" };
}

function parseMaxBytes(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1024 && parsed <= 65536 ? parsed : AGENT_CHAT_DEFAULT_MAX_BYTES;
}

function normalizedOrigin(origin: string): string {
  return origin.endsWith("/") ? origin : `${origin}/`;
}

function normalizeGraphqlRequest(request: {
  query: string;
  operationName?: string | undefined;
  variables: { input: object };
}): { query: string; operationName?: string; variables: { input: Record<string, unknown> } } {
  return {
    query: request.query,
    ...(request.operationName !== undefined ? { operationName: request.operationName } : {}),
    variables: { input: { ...request.variables.input } },
  };
}

function isQueenGraphqlOperation(request: ReturnType<typeof QueenGraphqlRequestSchema.parse>): boolean {
  if (request.operationName !== undefined) return true;
  return /\b(proposeTaskGraph|rankNodeAgents|selectNodeAgent|acceptNodeAssignment|confirmTaskGraph|startTaskRun|submitNodeOutput|judgeNodeOutput|requestAdversarialReview|repairNode|finalArbitrate|writeLearningLoop)\b/.test(request.query);
}

async function verifyTurnstile(token: string | undefined, secret: string, upstreamFetch: typeof fetch): Promise<boolean> {
  if (!token) return false;
  const body = new URLSearchParams({ secret, response: token });
  const response = await upstreamFetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body,
    signal: AbortSignal.timeout(4_000),
  });
  if (!response.ok) return false;
  const payload = await response.json() as { success?: boolean };
  return payload.success === true;
}

async function signRuntimeHeaders(
  method: string,
  path: string,
  body: string,
  secret: string,
  keyId: string,
): Promise<Record<string, string>> {
  const timestamp = Date.now();
  const nonce = crypto.randomUUID();
  const bodySha256 = await sha256Hex(body);
  const signature = await hmacSha256Hex(secret, [method.toUpperCase(), path, String(timestamp), nonce, bodySha256].join("\n"));
  return {
    [signedHeaderNames.keyId]: keyId,
    [signedHeaderNames.timestamp]: String(timestamp),
    [signedHeaderNames.nonce]: nonce,
    [signedHeaderNames.bodySha256]: bodySha256,
    [signedHeaderNames.signature]: signature,
  };
}

async function sha256Hex(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return toHex(hash);
}

async function hmacSha256Hex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return toHex(signature);
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function jsonAgentError(
  code: LiveChatError["code"],
  message: string,
  requestId: string | undefined,
  retryable: boolean,
  status: number,
  cors: Record<string, string>,
): Response {
  return Response.json(LiveChatErrorSchema.parse({ code, message, requestId, retryable }), {
    status,
    headers: { ...agentJsonHeaders(), ...cors },
  });
}

function sseAgentError(
  code: LiveChatError["code"],
  message: string,
  requestId: string,
  retryable: boolean,
  cors: Record<string, string>,
): Response {
  const error = { event: "error", error: LiveChatErrorSchema.parse({ code, message, requestId, retryable }) };
  return new Response(`event: error\ndata: ${JSON.stringify(error)}\n\n`, {
    status: 200,
    headers: {
      ...cors,
      "cache-control": "no-store",
      "content-type": "text/event-stream; charset=utf-8",
    },
  });
}

function graphqlAgentError(
  code: LiveChatError["code"],
  message: string,
  requestId: string,
  retryable: boolean,
  cors: Record<string, string>,
): Response {
  return Response.json({
    data: null,
    errors: [
      {
        message,
        extensions: { code, requestId, retryable },
      },
    ],
  }, {
    status: 200,
    headers: { ...agentJsonHeaders(), ...cors },
  });
}
