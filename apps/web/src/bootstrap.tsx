import type { ReactNode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";

import { parseRenderState, type RenderState } from "./ssr/renderState";

export interface ClientRootController {
  render(node: ReactNode): void;
  unmount(): void;
}

interface HydrateOptions {
  onRecoverableError(): void;
  onUncaughtError(): void;
}

interface BootstrapOptions {
  root: HTMLElement;
  state?: RenderState;
  currentPathname: string;
  buildVersion: string;
  buildApplication(interactive: boolean): ReactNode;
  hydrate?: (
    container: HTMLElement,
    application: ReactNode,
    options: HydrateOptions,
  ) => ClientRootController;
  create?: (container: HTMLElement) => ClientRootController;
  record(event: "hydration.recoverable_error" | "csr.fallback"): void;
}

export function readRenderStateFromDocument(
  documentRef: Document = document,
): RenderState | undefined {
  return parseRenderState(
    documentRef.getElementById("__AGENT_MARKET_RENDER_STATE__")?.textContent
      ?? null,
  );
}

export function bootstrapClient(options: BootstrapOptions): {
  mode: "hydrate" | "csr";
} {
  const hydrate = options.hydrate ?? ((container, application, callbacks) => (
    hydrateRoot(container, application, {
      onRecoverableError: callbacks.onRecoverableError,
      onUncaughtError: callbacks.onUncaughtError,
    })
  ));
  const create = options.create ?? ((container) => createRoot(container));
  let recovered = false;
  let hydratedRoot: ClientRootController | undefined;

  const renderCsr = () => {
    const root = create(options.root);
    root.render(options.buildApplication(true));
  };

  const recoverToCsr = () => {
    if (recovered) return;
    recovered = true;
    queueMicrotask(() => {
      try {
        hydratedRoot?.unmount();
      } finally {
        options.root.replaceChildren();
        options.record("csr.fallback");
        renderCsr();
      }
    });
  };

  const shouldHydrate = options.state?.mode === "ssr"
    && options.state.pathname === options.currentPathname
    && options.state.version === options.buildVersion
    && options.root.dataset.renderMode === "ssr"
    && options.root.hasChildNodes();

  if (!shouldHydrate) {
    if (options.state?.mode === "csr-fallback") {
      options.record("csr.fallback");
    }
    renderCsr();
    return { mode: "csr" };
  }

  try {
    hydratedRoot = hydrate(
      options.root,
      options.buildApplication(false),
      {
        onRecoverableError() {
          options.record("hydration.recoverable_error");
        },
        onUncaughtError: recoverToCsr,
      },
    );
    return { mode: "hydrate" };
  } catch {
    recoverToCsr();
    return { mode: "csr" };
  }
}
