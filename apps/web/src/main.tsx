import { StrictMode, useEffect, useState } from "react";
import { BrowserRouter } from "react-router-dom";

import App from "./App";
import { bootstrapClient, readRenderStateFromDocument } from "./bootstrap";
import { LanguageProvider } from "./i18n/LanguageProvider";
import { startPerformanceCollection } from "./performance/collector";
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
                <App />
              </BrowserRouter>
            )
          : <ServerApp pathname={globalThis.location.pathname} />}
      </LanguageProvider>
    </StrictMode>
  );
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

if (import.meta.env.PROD) {
  startPerformanceCollection({
    route: globalThis.location.pathname,
    version: buildVersion,
  });
}
