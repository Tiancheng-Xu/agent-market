import { StrictMode, useEffect, useState } from "react";
import { BrowserRouter } from "react-router-dom";

import App from "./App";
import { bootstrapClient, readRenderStateFromDocument } from "./bootstrap";
import { LanguageProvider } from "./i18n/LanguageProvider";
import { startPerformanceCollection } from "./performance/collector";
import { ServerApp } from "./ssr/ServerApp";
import { prepareRoute } from "./routeModules";
import { RouteLoadError } from "./components/RouteBoundary";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Root element is missing.");

const buildVersion = import.meta.env.VITE_APP_VERSION ?? "unknown";
const performanceCollection = import.meta.env.PROD
  ? startPerformanceCollection({
      route: globalThis.location.pathname,
      version: buildVersion,
    })
  : undefined;
let interactionRecorded = false;

function ClientApplication({ initialInteractive }: { initialInteractive: boolean }) {
  const [interactive, setInteractive] = useState(initialInteractive);
  const [startupFailed, setStartupFailed] = useState(false);

  useEffect(() => {
    let active = true;
    const timeout = globalThis.setTimeout(() => {
      if (active) { active = false; setStartupFailed(true); }
    }, 12_000);
    // Preserve the server content while the initial route chunk loads.
    void prepareRoute(globalThis.location.pathname).then(() => {
      if (active) { globalThis.clearTimeout(timeout); setInteractive(true); }
    }, () => {
      if (active) { globalThis.clearTimeout(timeout); setStartupFailed(true); }
    });
    return () => { active = false; globalThis.clearTimeout(timeout); };
  }, []);

  useEffect(() => {
    if (interactive && !interactionRecorded) {
      interactionRecorded = true;
      performanceCollection?.markInteractive();
    }
  }, [interactive]);

  return (
    <StrictMode>
      <LanguageProvider>
        {startupFailed ? <RouteLoadError /> : interactive
          ? (
              <BrowserRouter>
                <App />
              </BrowserRouter>
            )
          : <ServerApp pathname={globalThis.location.pathname} />}
      </LanguageProvider>
    </StrictMode>
  );
}

const renderState = readRenderStateFromDocument();

const bootstrapResult = bootstrapClient({
  root,
  ...(renderState ? { state: renderState } : {}),
  currentPathname: globalThis.location.pathname,
  buildVersion,
  buildApplication: (interactive) => (
    <ClientApplication initialInteractive={interactive} />
  ),
  record(event) {
    performanceCollection?.recordRenderEvent(event);
    globalThis.dispatchEvent(new CustomEvent("agent-market:render", {
      detail: { event },
    }));
  },
});
performanceCollection?.recordBootstrapMode(bootstrapResult.mode);
