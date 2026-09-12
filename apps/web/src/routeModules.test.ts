import { beforeEach, describe, expect, it, vi } from "vitest";

const loads = vi.hoisted(() => ({ local: vi.fn(), order: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  // resetModules does not invalidate the mock registry's resolved exports.
  vi.doMock("./pages/LocalAgentsPage", () => {
    loads.local();
    return { LocalAgentsPage: () => null };
  });
  vi.doMock("./pages/OrderDetailRoute", () => {
    loads.order();
    return { default: () => null };
  });
});

describe("initial route module preparation", () => {
  const routes: Array<[string, number, number]> = [
    ["/", 0, 0],
    ["/agents", 0, 0],
    ["/agents/local", 1, 0],
    ["/agents/local/", 1, 0],
    ["/tasks/new", 0, 0],
    ["/tasks/order-id", 0, 1],
    ["/tasks/order-id/", 0, 1],
    ["/tasks/order-id/workspace", 0, 0],
    ["/office", 0, 0],
  ];

  it.each(routes)("loads only the dependency for %s", async (path, local, order) => {
    const { prepareRoute } = await import("./routeModules");
    expect(loads.local).not.toHaveBeenCalled();
    expect(loads.order).not.toHaveBeenCalled();
    await prepareRoute(path);
    expect(loads.local).toHaveBeenCalledTimes(local);
    expect(loads.order).toHaveBeenCalledTimes(order);
  });

  it("shares in-flight imports between preparation and React.lazy", async () => {
    const { loadLocalRoute, loadOrderRoute, prepareRoute } = await import("./routeModules");
    const local = loadLocalRoute();
    const order = loadOrderRoute();
    expect(loadLocalRoute()).toBe(local);
    expect(loadOrderRoute()).toBe(order);
    await Promise.all([prepareRoute("/agents/local"), prepareRoute("/tasks/order-id")]);
    expect(loads.local).toHaveBeenCalledTimes(1);
    expect(loads.order).toHaveBeenCalledTimes(1);
    expect(loadLocalRoute()).toBe(local);
    expect(loadOrderRoute()).toBe(order);
  });
});
