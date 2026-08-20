import { renderRouteStream } from "./entry-server";
import { buildCsrFallbackDocument, composeSsrDocument } from "./ssr/html";
import type { RenderState } from "./ssr/renderState";
import { routeForPath } from "./ssr/routeDefinitions";

export interface PagesEnvironment {
  ASSETS: { fetch(request: Request): Promise<Response> };
  API_ORIGIN?: string;
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

function isDocumentRequest(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const pathname = new URL(request.url).pathname;
  if (pathname.startsWith("/assets/") || /\.[a-z0-9]+$/i.test(pathname)) {
    return false;
  }
  return request.headers.get("accept")?.includes("text/html") ?? false;
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
      if (requestUrl.pathname === "/api/performance") {
        if (request.method !== "POST") {
          return Response.json({ error: "METHOD_NOT_ALLOWED" }, { status: 405 });
        }
        if (!environment.API_ORIGIN) {
          return Response.json({ error: "PERFORMANCE_ORIGIN_UNAVAILABLE" }, {
            status: 503,
          });
        }

        const origin = environment.API_ORIGIN.endsWith("/")
          ? environment.API_ORIGIN
          : `${environment.API_ORIGIN}/`;
        const upstreamRequest = new Request(
          new URL("performance", origin),
          request,
        );
        upstreamRequest.headers.delete("authorization");
        upstreamRequest.headers.delete("cookie");
        return upstreamFetch(upstreamRequest);
      }

      if (!isDocumentRequest(request)) return environment.ASSETS.fetch(request);

      const startedAt = now();
      const pathname = new URL(request.url).pathname;
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

export default createPagesHandler();
