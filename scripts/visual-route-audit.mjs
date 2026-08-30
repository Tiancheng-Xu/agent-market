import { mkdir, writeFile } from "node:fs/promises";

const baseUrl = process.env.AGENT_MARKET_AUDIT_URL ?? "http://127.0.0.1:4173";
const cdpUrl = process.env.AGENT_MARKET_CDP_URL ?? "http://127.0.0.1:9223";
const outputDirectory = process.env.AGENT_MARKET_AUDIT_OUTPUT ?? "/tmp/agent-market-visual-audit";

const routes = [
  "/",
  "/agents",
  "/agents/new",
  "/agents/local",
  "/agents/personal-image-agent",
  "/tasks",
  "/tasks/new",
  "/tasks/task-research-brief",
  "/tasks/task-research-brief/matches",
  "/tasks/task-research-brief/workspace",
  "/office",
  "/dashboard",
  "/staking",
  "/committee",
  "/disputes/dispute-demo",
  "/ops",
  "/evidence",
  "/missing",
];
const widths = [375, 390, 430, 1440, 1920];
const locales = ["zh-CN", "en"];
const screenshotRoutes = new Set([
  "/",
  "/agents",
  "/agents/new",
  "/agents/local",
  "/tasks",
  "/tasks/new",
  "/office",
  "/staking",
  "/committee",
  "/ops",
  "/evidence",
]);

await mkdir(outputDirectory, { recursive: true });
const httpReadback = await Promise.all(routes.map(async (route) => ({
  route,
  status: (await fetch(`${baseUrl}${route}`, { redirect: "manual", headers: { accept: "text/html" } })).status,
  expected: route === "/missing" ? 404 : 200,
})));

const targets = await fetch(`${cdpUrl}/json`).then((response) => response.json());
const pageTarget = targets.find((target) => target.type === "page");
if (!pageTarget?.webSocketDebuggerUrl) throw new Error("Chrome page target unavailable");

const socket = new WebSocket(pageTarget.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});

let nextId = 1;
const pending = new Map();
const pageErrors = [];
let activeRoute = "startup";
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.method === "Runtime.exceptionThrown") {
    pageErrors.push({
      route: activeRoute,
      text: message.params?.exceptionDetails?.text ?? "Uncaught exception",
    });
    return;
  }
  if (!message.id || !pending.has(message.id)) return;
  const handler = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) handler.reject(new Error(JSON.stringify(message.error)));
  else handler.resolve(message.result);
};

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return result.result.value;
}
async function waitFor(expression) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await evaluate(expression)) return;
    await sleep(50);
  }
  throw new Error(`Browser condition timed out: ${expression}`);
}

await send("Page.enable");
await send("Runtime.enable");
const results = [];

for (const width of widths) {
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height: 900,
    deviceScaleFactor: 1,
    mobile: width < 760,
  });

  for (const route of routes) {
    activeRoute = route;
    const navigationStartedAt = performance.now();
    await send("Page.navigate", { url: `${baseUrl}${route}` });
    await sleep(600);
    let cocosReadyMs = null;
    if (route === "/office") {
      await waitFor('document.querySelector(".cocos-office-host")?.classList.contains("cocos-office-ready")');
      cocosReadyMs = Math.round(performance.now() - navigationStartedAt);
    }
    for (const locale of locales) {
      const label = locale === "zh-CN" ? "中文" : "EN";
      await waitFor(`document.documentElement.lang === ${JSON.stringify(locale)} || [...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === ${JSON.stringify(label)})`);
      await evaluate(`[...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === ${JSON.stringify(label)})?.click()`);
      await waitFor(`document.documentElement.lang === ${JSON.stringify(locale)}`);
      await sleep(120);

      const audit = await evaluate(`(() => {
      const lines = document.body.innerText.split(/\\n+/).map((line) => line.trim()).filter(Boolean);
      const english = lines.filter((line) => {
        const words = line.match(/[A-Za-z][A-Za-z'-]*/g) || [];
        return words.length >= 4;
      });
      const chinese = lines.filter((line) => (line.match(/[\\u3400-\\u9fff]/g) || []).length >= 4);
      return {
        title: document.title,
        lang: document.documentElement.lang,
        innerWidth,
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        brokenImages: [...document.images]
          .filter((image) => image.complete && image.naturalWidth === 0)
          .map((image) => image.src),
        emptyButtons: [...document.querySelectorAll("button")]
          .filter((button) => !button.getAttribute("aria-label") && !button.innerText.trim()).length,
        cocosOfficeReady: ${JSON.stringify(route)} !== "/office"
          || document.querySelector(".cocos-office-host")?.classList.contains("cocos-office-ready") === true,
        english: [...new Set(english)].slice(0, 50),
        chinese: [...new Set(chinese)].slice(0, 50),
      };
    })()`);
      results.push({ width, route, locale, cocosReadyMs, ...audit });

      if ((width === 390 || width === 1920) && screenshotRoutes.has(route)) {
        const screenshot = await send("Page.captureScreenshot", {
          format: "png",
          fromSurface: true,
          captureBeyondViewport: false,
        });
        const slug = route === "/" ? "home" : route.slice(1).replaceAll("/", "-");
        await writeFile(`${outputDirectory}/${width}-${locale}-${slug}.png`, Buffer.from(screenshot.data, "base64"));
      }
    }
  }
}

socket.close();
const technicalEnglish = (line) =>
  /^(?:\.tc-flow|apps|docs|infra|packages|scripts|services)\//.test(line)
  || /^\//.test(line)
  || /^(?:Ollama|DeepSeek API|Moonshot Kimi API|Qwen API|Zhipu API)\s*\//.test(line)
  || /^(?:Personal AI Runtime|Personal AI Historical)(?:\s+[vV]?[0-9.]+)?$/.test(line)
  || /^(?:Personal Ai Agent|Course Knowledge Assistant)(?:\s+[vV]?[0-9.]+)?$/.test(line)
  || /^Qwen(?:2\.5|3)\b/.test(line)
  || line === "Kimi K2 7 Code Highspeed"
  || (!/[.!?]/.test(line) && line.split(/\s+/).length <= 5);
const untranslated = results
  .filter(({ locale }) => locale === "zh-CN")
  .map(({ width, route, locale, english }) => ({
    width,
    route,
    locale,
    english: english.filter((line) => !/[\u3400-\u9fff]/.test(line) && !technicalEnglish(line)),
  }))
  .filter((result) => result.english.length > 0);
const untranslatedEnglish = results
  .filter(({ locale }) => locale === "en")
  .map(({ width, route, locale, chinese }) => ({ width, route, locale, chinese }))
  .filter((result) => result.chinese.length > 0);
const mixedLanguage = results
  .filter(({ locale }) => locale === "zh-CN")
  .map(({ width, route, locale, english }) => ({ width, route, locale, mixed: english.filter((line) => /[\u3400-\u9fff]/.test(line) && ((line.match(/\b(?:the|and|are|remains|until|with|without|only|from|into|lazy|weak|low|reduced|sanitized)\b/gi) ?? []).length >= 3)) }))
  .filter((result) => result.mixed.length > 0);
const summary = {
  checked: results.length,
  widths,
  locales,
  routeCount: routes.length,
  httpReadback,
  overflow: results.filter((result) => result.overflow),
  brokenImages: results.filter((result) => result.brokenImages.length > 0),
  emptyButtons: results.filter((result) => result.emptyButtons > 0),
  cocosReadyFailures: results.filter((result) => result.route === "/office" && !result.cocosOfficeReady),
  cocosReadyMs: results.filter((result) => result.route === "/office" && result.locale === "zh-CN").map(({ width, cocosReadyMs }) => ({ width, cocosReadyMs })),
  pageErrors,
  untranslated,
  untranslatedEnglish,
  mixedLanguage,
};
await writeFile(`${outputDirectory}/result.json`, `${JSON.stringify({ summary, results }, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (summary.httpReadback.some((entry) => entry.status !== entry.expected) || summary.overflow.length || summary.brokenImages.length || summary.emptyButtons.length || summary.cocosReadyFailures.length || summary.cocosReadyMs.some((entry) => entry.cocosReadyMs === null || entry.cocosReadyMs > 5000) || summary.pageErrors.length || summary.untranslated.length || summary.untranslatedEnglish.length || summary.mixedLanguage.length) {
  process.exitCode = 1;
}
