import { expect, it } from "vitest";

import { resolveRequestId } from "./request-context";

it("keeps a valid request id and replaces invalid input", () => {
  const valid = "018f3f50-7b2d-7cc1-98f5-9ab68e75a211";

  expect(resolveRequestId(new Headers({ "x-request-id": valid }))).toBe(valid);
  expect(
    resolveRequestId(new Headers({ "x-request-id": "not-a-uuid" })),
  ).toMatch(/^[0-9a-f-]{36}$/);
});
