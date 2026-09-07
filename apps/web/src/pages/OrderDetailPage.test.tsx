import { existsSync, readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  OrderDetailPage,
  failedLiveReputationState,
  initialOrderReputationState,
} from "./OrderDetailPage";
import { createOrderQueryClient } from "./orderQueryClient";
import { orderQueryKeys } from "./orderQueryClient";

describe("OrderDetailPage trust boundaries", () => {
  it.each([false, true])("does not render fixture budgets for an unloaded live order (failure=%s)", async (failed) => {
    const id = "11111111-1111-4111-8111-111111111111";
    const client = createOrderQueryClient();
    client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retryOnMount: false } });
    if (failed) {
      await client.fetchQuery({
        queryKey: orderQueryKeys.order(id),
        queryFn: async () => { throw new Error("ORDER_READ_UNAVAILABLE"); },
      }).catch(() => undefined);
    }
    const markup = renderToStaticMarkup(
      <MemoryRouter initialEntries={[`/tasks/${id}`]}>
        <Routes>
          <Route path="/tasks/:id" element={<QueryClientProvider client={client}><OrderDetailPage /></QueryClientProvider>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(markup).toContain(failed ? "Order unavailable" : "Loading order");
    expect(markup).not.toContain("Escrow budget");
    expect(markup).not.toContain("UI FIXTURE");
    expect(markup).not.toContain("Order lifecycle");
  });

  it("labels deterministic fixture reputation and pricing as UI-only simulation", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/tasks/interface-fixture"]}>
        <Routes>
          <Route path="/tasks/:id" element={<QueryClientProvider client={createOrderQueryClient()}><OrderDetailPage walletAddress="0xfixture-wallet-must-not-render" /></QueryClientProvider>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(markup).toContain("UI FIXTURE");
    expect(markup).toContain("SIMULATION_ONLY");
    expect(markup).toContain("Deterministic aggregate for interface validation only");
    expect(markup).toContain("does not authorize funding or claim Sepolia enforcement");
    expect(markup).not.toContain("0xfixture-wallet-must-not-render");
  });

  it("never converts a live reputation failure into fixture data", () => {
    expect(initialOrderReputationState(true)).toEqual({ kind: "loading" });
    expect(failedLiveReputationState()).toEqual({
      kind: "unavailable",
      reason: "public-api-unavailable",
    });
    expect(failedLiveReputationState()).not.toHaveProperty("snapshot");
  });

  it("does not issue a risk quote without an authoritative fingerprint and current quote", () => {
    const source = readFileSync(new URL("./OrderDetailPage.tsx", import.meta.url), "utf8");

    expect(source).not.toContain("requestRiskQuote(");
    expect(source).toContain("No quote request was sent");
    expect(source).toContain("readAgentReputation(order.agentId)");
    expect(source).not.toContain("readAgentReputation(walletAddress");
  });

  it("owns live order, reputation and command state through bounded TanStack queries", () => {
    const source = readFileSync(new URL("./OrderDetailPage.tsx", import.meta.url), "utf8");

    expect(source).toContain("useQuery(");
    expect(source).toContain("useMutation(");
    expect(source).toContain("useQueryClient(");
    expect(source).not.toContain("useEffect(");
    expect(source).not.toContain("setMessage(");
  });

  it("does not expose the system-owned matching transition in browser UI", () => {
    const source = readFileSync(new URL("./OrderDetailPage.tsx", import.meta.url), "utf8");

    expect(source).not.toContain("start_matching");
    expect(source).not.toContain("Start matching");
  });

  it("does not expose funding preparation without confirmed quote context", () => {
    const liveOrderId = "11111111-1111-4111-8111-111111111111";
    const client = createOrderQueryClient();
    client.setQueryData(orderQueryKeys.order(liveOrderId), {
      id: liveOrderId,
      publisherWallet: "0x1111111111111111111111111111111111111111",
      agentId: null,
      agentWallet: null,
      title: "Quote-gated order",
      budgetAtomic: "100",
      status: "open",
      version: 1,
      artifacts: [],
      reviewEligible: false,
      manualReview: null,
      updatedAt: "2026-09-01T12:00:00.000Z",
    });

    const markup = renderToStaticMarkup(
      <MemoryRouter initialEntries={[`/tasks/${liveOrderId}`]}>
        <Routes>
          <Route path="/tasks/:id" element={<QueryClientProvider client={client}><OrderDetailPage walletAddress="0x1111111111111111111111111111111111111111" /></QueryClientProvider>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(markup).not.toContain("Prepare funding");
  });

  it("configures an isolated order QueryClient with bounded freshness and retry", () => {
    const clientUrl = new URL("./orderQueryClient.ts", import.meta.url);
    const source = existsSync(clientUrl) ? readFileSync(clientUrl, "utf8") : "";
    const firstServerClient = createOrderQueryClient();
    const secondServerClient = createOrderQueryClient();
    const defaults = firstServerClient.getDefaultOptions();

    expect(Number(defaults.queries?.staleTime)).toBeGreaterThan(0);
    expect(defaults.queries?.retry).toBe(false);
    expect(defaults.mutations?.retry).toBe(false);
    expect(firstServerClient).not.toBe(secondServerClient);
    expect(source).toContain('typeof window === "undefined"');
  });

  it("keeps order data dependencies behind lazy route chunks", () => {
    const appSource = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");

    expect(appSource).toContain('lazy(() => import("./pages/OrderDetailRoute")');
    expect(appSource).toContain('lazy(() => import("./pages/LocalAgentsPage")');
    expect(appSource).toContain("<Suspense fallback={<RouteFallback />}");
    expect(appSource).not.toContain("@tanstack/react-query");
    expect(appSource).toContain('<Route path="*" element={<NotFoundPage />} />');
  });
});
