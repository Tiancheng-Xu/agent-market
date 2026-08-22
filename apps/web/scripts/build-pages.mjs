import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { validateBuiltRenderingRuntime } from "./validate-rendering-runtime.mjs";

const webRoot = resolve(import.meta.dirname, "..");
const clientDirectory = resolve(webRoot, "dist-client");
const workerDirectory = resolve(webRoot, "dist-worker");
const outputDirectory = resolve(webRoot, "dist");

function runVite(args) {
  const result = spawnSync("vite", args, {
    cwd: webRoot,
    env: process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function verifyPagesOutput(directory) {
  const indexPath = resolve(directory, "index.html");
  const workerPath = resolve(directory, "_worker.js");
  const [index, worker, indexStats, workerStats] = await Promise.all([
    readFile(indexPath, "utf8"),
    readFile(workerPath, "utf8"),
    stat(indexPath),
    stat(workerPath),
  ]);

  if (!index.includes('<div id="root"></div>')) {
    throw new Error("Built index.html is missing the exact SSR root marker.");
  }
  if (indexStats.size < 256 || workerStats.size < 1_024) {
    throw new Error("Cloudflare Pages output is unexpectedly empty.");
  }
  for (const marker of ["window.ethereum", "useWallet", "MetaMaskProvider"]) {
    if (worker.includes(marker)) {
      throw new Error(`Edge bundle contains browser-only marker: ${marker}`);
    }
  }
  return { indexBytes: indexStats.size, workerBytes: workerStats.size };
}

async function verifyPagesFunctionEntry(directory) {
  const entryPath = resolve(webRoot, "..", "..", "functions", "[[path]].js");
  const module = await import(`${pathToFileURL(entryPath).href}?v=${Date.now()}`);
  if (typeof module.onRequest !== "function") {
    throw new Error("Cloudflare Pages function entry is missing onRequest().");
  }
  const index = await readFile(resolve(directory, "index.html"), "utf8");
  const response = await module.onRequest({
    request: new Request("https://agent-market.test/evidence", {
      headers: { accept: "text/html" },
    }),
    env: {
      ASSETS: {
        fetch() {
          return Promise.resolve(new Response(index, {
            headers: { "content-type": "text/html; charset=utf-8" },
          }));
        },
      },
    },
    params: {},
    data: {},
    next() {
      return Promise.resolve(new Response("unexpected-next", { status: 500 }));
    },
    waitUntil() {},
    passThroughOnException() {},
  });
  if (response.headers.get("x-agent-market-render-mode") !== "ssr") {
    throw new Error("Cloudflare Pages function entry did not run the SSR handler.");
  }
}

await Promise.all([
  rm(clientDirectory, { recursive: true, force: true }),
  rm(workerDirectory, { recursive: true, force: true }),
  rm(outputDirectory, { recursive: true, force: true }),
]);

runVite(["build", "--outDir", "dist-client"]);
runVite(["build", "--config", "vite.ssr.config.ts"]);

await mkdir(outputDirectory, { recursive: true });
await cp(clientDirectory, outputDirectory, { recursive: true });
await rm(resolve(clientDirectory, "_redirects"), { force: true });
await cp(
  resolve(workerDirectory, "_worker.js"),
  resolve(outputDirectory, "_worker.js"),
);
await cp(
  resolve(workerDirectory, "_worker.js"),
  resolve(clientDirectory, "_worker.js"),
);

const output = await verifyPagesOutput(outputDirectory);
await verifyPagesOutput(clientDirectory);
await verifyPagesFunctionEntry(outputDirectory);
const runtime = await validateBuiltRenderingRuntime(
  resolve(outputDirectory, "_worker.js"),
);
console.log(
  `Cloudflare Pages edge build ready: index=${output.indexBytes} bytes, worker=${output.workerBytes} bytes, runtime-cases=${runtime.cases}, dual-output-worker=true.`,
);
