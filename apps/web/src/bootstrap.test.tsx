import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { bootstrapClient, type ClientRootController } from "./bootstrap";

function rootWithMarkup() {
  let replacements = 0;
  return {
    root: {
      dataset: { renderMode: "ssr" },
      hasChildNodes: () => true,
      replaceChildren: () => { replacements += 1; },
    } as unknown as HTMLElement,
    replacements: () => replacements,
  };
}

describe("client bootstrap", () => {
  it("hydrates only matching edge markup", () => {
    const { root } = rootWithMarkup();
    let hydrated = 0;
    let created = 0;
    const controller: ClientRootController = { render() {}, unmount() {} };

    const result = bootstrapClient({
      root,
      state: { mode: "ssr", pathname: "/evidence", version: "v1" },
      currentPathname: "/evidence",
      buildVersion: "v1",
      buildApplication: () => null,
      hydrate(_container: HTMLElement, _node: ReactNode) {
        hydrated += 1;
        return controller;
      },
      create() {
        created += 1;
        return controller;
      },
      record() {},
    });

    expect(result.mode).toBe("hydrate");
    expect(hydrated).toBe(1);
    expect(created).toBe(0);
  });

  it("performs at most one CSR remount after a fatal hydration error", async () => {
    const { root, replacements } = rootWithMarkup();
    let fatal: (() => void) | undefined;
    let created = 0;
    let rendered = 0;
    let unmounted = 0;
    const events: string[] = [];

    bootstrapClient({
      root,
      state: { mode: "ssr", pathname: "/tasks", version: "v1" },
      currentPathname: "/tasks",
      buildVersion: "v1",
      buildApplication: () => null,
      hydrate(_container, _node, options) {
        fatal = options.onUncaughtError;
        return { render() {}, unmount() { unmounted += 1; } };
      },
      create() {
        created += 1;
        return { render() { rendered += 1; }, unmount() {} };
      },
      record(event) { events.push(event); },
    });

    fatal?.();
    fatal?.();
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));

    expect(unmounted).toBe(1);
    expect(replacements()).toBe(1);
    expect(created).toBe(1);
    expect(rendered).toBe(1);
    expect(events).toEqual(["csr.fallback"]);
  });
});
