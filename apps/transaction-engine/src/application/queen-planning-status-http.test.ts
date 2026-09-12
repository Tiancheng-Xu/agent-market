import { expect, it, vi } from "vitest";
import { AuthError } from "../auth/session";
import { createQueenPlanningStatusHandler } from "./queen-planning-status-http";

const id = "11111111-1111-4111-8111-111111111111";
const wallet = `0x${"a".repeat(40)}`;
const status = { task: { taskId: id, taskVersion: 1, status: "open" }, request: null, canApprove: false, executionVerified: false as const };
function setup() {
  const auth = { authenticateSession: vi.fn(async () => ({ walletAddress: wallet })) };
  const read = vi.fn(async () => status);
  return { auth, read, handler: createQueenPlanningStatusHandler({ authOrigin: new URL("https://market.example"), auth, read }) };
}
function request(extra: Record<string, string> = {}, search = "") {
  return new Request(`https://market.example/api/tasks/${id}/planning-request${search}`, {
    headers: { cookie: `__Host-agent_market_session=${"a".repeat(43)}`, ...extra },
  });
}
it("reads only as the authenticated wallet without enabling a producer", async () => {
  const { handler, read } = setup();
  const result = await handler(request(), id);
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual(status);
  expect(read).toHaveBeenCalledWith({ taskId: id, actorWallet: wallet });
  expect(result.headers.get("cache-control")).toBe("no-store");
});
it("rejects missing sessions before touching task storage", async () => {
  const { handler, read } = setup();
  expect((await handler(new Request("https://market.example/"), id)).status).toBe(401);
  expect(read).not.toHaveBeenCalled();
});
it("rejects revoked sessions before touching task storage", async () => {
  const { handler, read, auth } = setup();
  auth.authenticateSession.mockRejectedValueOnce(new AuthError("AUTH_SESSION_INVALID"));
  expect((await handler(request(), id)).status).toBe(401);
  expect(read).not.toHaveBeenCalled();
});
it.each([{ origin: "https://attacker.example" }, { "sec-fetch-site": "cross-site" }])("rejects a foreign read context", async headers => {
  const { handler, auth, read } = setup();
  expect((await handler(request(headers), id)).status).toBe(403);
  expect(auth.authenticateSession).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});
it("does not accept actor or state overrides in query parameters", async () => {
  const { handler, read } = setup();
  expect((await handler(request({}, "?actorWallet=another-wallet"), id)).status).toBe(400);
  expect(read).not.toHaveBeenCalled();
});
it("does not leak storage errors or credentials", async () => {
  const { handler, read } = setup();
  read.mockRejectedValueOnce(new Error("postgres://private:secret@internal/private-prompt"));
  const result = await handler(request(), id);
  expect(result.status).toBe(503);
  expect(await result.json()).toEqual({ error: "QUEEN_PLANNING_UNAVAILABLE" });
});
it("never handles a mutation on the read port", async () => {
  const { handler, read } = setup();
  const result = await handler(new Request("https://market.example/", { method: "POST" }), id);
  expect(result.status).toBe(405);
  expect(result.headers.get("allow")).toBe("GET");
  expect(read).not.toHaveBeenCalled();
});
