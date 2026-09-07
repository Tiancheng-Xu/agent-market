import { QueryClient, useQueryClient } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import OrderDetailRoute from "./OrderDetailRoute";

const observed = vi.hoisted(() => ({ clients: [] as QueryClient[] }));
vi.mock("./OrderDetailPage", () => ({
  OrderDetailPage: () => {
    observed.clients.push(useQueryClient());
    return null;
  },
}));

afterEach(() => {
  observed.clients.forEach((client) => client.clear());
  observed.clients.length = 0;
  vi.unstubAllGlobals();
});

describe("order route query ownership", () => {
  it("does not reuse a browser singleton across mounted wallet sessions", () => {
    vi.stubGlobal("window", {});
    const wallets = ["0xaaa", "0xbbb", null, "0xaaa"];
    for (const walletAddress of wallets) {
      renderToString(<MemoryRouter><OrderDetailRoute walletAddress={walletAddress} /></MemoryRouter>);
      const client = observed.clients.at(-1)!;
      expect(client.getQueryData(["order", "same-order"])).toBeUndefined();
      client.setQueryData(["order", "same-order"], { privateOwner: walletAddress });
    }
    expect(new Set(observed.clients).size).toBe(wallets.length);
  });
});
