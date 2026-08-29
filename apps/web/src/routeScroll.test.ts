import { describe, expect, it, vi } from "vitest";

import { resetRouteScroll } from "./routeScroll";

describe("route scroll reset", () => {
  it("resets the viewport and every application scroll container", () => {
    const viewportScroll = vi.fn();
    const scrollingElement = { scrollTop: 400, scrollLeft: 40 };
    const containers = [
      { scrollTop: 200, scrollLeft: 20 },
      { scrollTop: 201, scrollLeft: 21 },
      { scrollTop: 202, scrollLeft: 22 },
    ];
    const documentRoot = {
      documentElement: { style: { scrollBehavior: "smooth" } },
      scrollingElement,
      querySelectorAll: vi.fn(() => containers),
    } as unknown as Document;

    resetRouteScroll(documentRoot, { scrollTo: viewportScroll });

    expect(viewportScroll).toHaveBeenCalledWith(0, 0);
    expect(documentRoot.documentElement.style.scrollBehavior).toBe("smooth");
    expect(scrollingElement).toEqual({ scrollTop: 0, scrollLeft: 0 });
    expect(containers.every((container) => container.scrollTop === 0 && container.scrollLeft === 0)).toBe(true);
  });
});
