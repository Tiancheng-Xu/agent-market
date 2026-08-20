import { describe, expect, it } from "vitest";

import { parseRenderState, safeSerializeRenderState } from "./renderState";

describe("render state", () => {
  it("round-trips a valid state without executable markup", () => {
    const serialized = safeSerializeRenderState({
      mode: "ssr",
      pathname: "/evidence?<script>",
      version: "v1",
    });

    expect(serialized).not.toContain("<script>");
    expect(parseRenderState(serialized)).toEqual({
      mode: "ssr",
      pathname: "/evidence?<script>",
      version: "v1",
    });
  });

  it("rejects unknown serialized fields", () => {
    expect(parseRenderState(JSON.stringify({
      mode: "ssr",
      pathname: "/",
      version: "v1",
      secret: "must-not-cross-boundary",
    }))).toBeUndefined();
  });
});
