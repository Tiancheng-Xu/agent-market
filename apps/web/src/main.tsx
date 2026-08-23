import { StrictMode, useEffect, useState } from "react";
import { BrowserRouter, useLocation } from "react-router-dom";

import App from "./App";
import { bootstrapClient, readRenderStateFromDocument } from "./bootstrap";
import { LanguageProvider } from "./i18n/LanguageProvider";
import { startPerformanceCollection } from "./performance/collector";
import { applyPerformanceProfile, watchPerformanceProfile } from "./performance/degradation";
import { ServerApp } from "./ssr/ServerApp";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Root element is missing.");

const buildVersion = import.meta.env.VITE_APP_VERSION ?? "unknown";

function ClientApplication({ initialInteractive }: { initialInteractive: boolean }) {
  const [interactive, setInteractive] = useState(initialInteractive);

  useEffect(() => {
    setInteractive(true);
  }, []);

  return (
    <StrictMode>
      <LanguageProvider>
        {interactive
          ? (
              <BrowserRouter>
                <PerformanceRouteCollector />
                <App />
              </BrowserRouter>
            )
          : <ServerApp pathname={globalThis.location.pathname} />}
      </LanguageProvider>
    </StrictMode>
  );
}

function PerformanceRouteCollector() {
  const location = useLocation();
  useEffect(() => {
    const stopWatching = watchPerformanceProfile(applyPerformanceProfile);
    if (!import.meta.env.PROD) return stopWatching;
    const collector = startPerformanceCollection({ route: location.pathname, version: buildVersion });
    return () => { stopWatching(); void collector.flush(); collector.stop(); };
  }, [location.pathname]);
  return null;
}

const renderState = readRenderStateFromDocument();

bootstrapClient({
  root,
  ...(renderState ? { state: renderState } : {}),
  currentPathname: globalThis.location.pathname,
  buildVersion,
  buildApplication: (interactive) => (
    <ClientApplication initialInteractive={interactive} />
  ),
  record(event) {
    globalThis.dispatchEvent(new CustomEvent("agent-market:render", {
      detail: { event },
    }));
  },
});
