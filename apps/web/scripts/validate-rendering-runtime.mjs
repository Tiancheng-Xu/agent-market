import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const template =
  '<!doctype html><html><body><div id="root"></div><script src="/assets/app.js"></script></body></html>';

function environment() {
  return {
    ASSETS: {
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        return pathname === "/index.html"
          ? new Response(template)
          : new Response("asset-not-found", { status: 404 });
      },
    },
  };
}

export async function validateBuiltRenderingRuntime(workerPath) {
  const moduleUrl = `${pathToFileURL(workerPath).href}?validation=${Date.now()}`;
  const workerModule = await import(moduleUrl);
  const worker = workerModule.default;
  if (!worker || typeof worker.fetch !== "function") {
    throw new Error("Built Pages Worker has no fetch handler.");
  }

  const scenarios = [
    { path: "/evidence", status: 200, mode: "ssr" },
    { path: "/tasks/task-01/workspace", status: 200, mode: "ssr" },
    { path: "/missing", status: 404, mode: "ssr" },
    { path: "/missing-default-accept", status: 404, mode: "ssr", accept: "*/*" },
  ];
  for (const scenario of scenarios) {
    const response = await worker.fetch(new Request(
      `https://runtime.test${scenario.path}`,
      { headers: { accept: scenario.accept ?? "text/html" } },
    ), environment());
    if (response.status !== scenario.status) {
      throw new Error(`Runtime status failed for ${scenario.path}.`);
    }
    if (response.headers.get("x-agent-market-render-mode") !== scenario.mode) {
      throw new Error(`Runtime render mode failed for ${scenario.path}.`);
    }
    if (!(await response.text()).includes('data-render-mode="ssr"')) {
      throw new Error(`Runtime SSR body failed for ${scenario.path}.`);
    }
  }

  const asset = await worker.fetch(new Request(
    "https://runtime.test/assets/app.js",
    { headers: { accept: "*/*" } },
  ), environment());
  if (asset.status !== 404 || await asset.text() !== "asset-not-found") {
    throw new Error("Runtime asset delegation failed.");
  }

  if (typeof workerModule.createPagesHandler !== "function") {
    throw new Error("Built Pages Worker has no injectable handler.");
  }
  const fallbackWorker = workerModule.createPagesHandler({
    version: "validation",
    async render() { throw new Error("forced-render-failure"); },
    logger: { info() {}, error() {} },
  });
  const fallback = await fallbackWorker.fetch(new Request(
    "https://runtime.test/tasks",
    { headers: { accept: "text/html" } },
  ), environment());
  if (
    fallback.headers.get("x-agent-market-render-mode") !== "csr-fallback"
    || !(await fallback.text()).includes('data-render-mode="csr-fallback"')
  ) {
    throw new Error("Runtime CSR fallback failed.");
  }

  return { cases: scenarios.length + 2 };
}

const isCli = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isCli) {
  const result = await validateBuiltRenderingRuntime(
    resolve(process.argv[2] ?? "dist/_worker.js"),
  );
  console.log(`Built Worker runtime matrix passed: ${result.cases} cases.`);
}
