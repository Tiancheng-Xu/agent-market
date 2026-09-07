import { expect, it, vi } from "vitest";
import { createQueenPlanningApprovalHandler } from "./route";

const taskId = "0191f6f8-cb6b-7f31-81ad-c497d7d90301";
const requestId = "0191f6f8-cb6b-7f31-81ad-c497d7d90302";
const fingerprint = `sha256:${"a".repeat(64)}`;

const request = (body: unknown, origin = "https://agent-market.test") => new Request(
  `https://agent-market.test/api/tasks/${taskId}/planning-approval`, {
    method: "POST",
    headers: { origin, cookie: "__Host-agent_market_session=test-session", "content-type": "application/json" },
    body: JSON.stringify(body),
  },
);

it("accepts a strict approval body and derives the wallet only from the authenticated session", async () => {
  const approve = vi.fn(async () => ({ approvalId: "0191f6f8-cb6b-7f31-81ad-c497d7d90303", status: "queued" as const, duplicate: false }));
  const authenticateSession = vi.fn(async () => ({ walletAddress: "0x1111111111111111111111111111111111111111" }));
  const handler = createQueenPlanningApprovalHandler({
    enabled: true, authOrigin: new URL("https://agent-market.test"),
    auth: { authenticateSession }, approve,
  });
  const response = await handler(request({ requestId, taskVersion: 1, graphRevision: 1,
    taskFingerprint: fingerprint, approved: true, actorWallet: "0x2222222222222222222222222222222222222222" }), taskId);
  expect(response.status).toBe(400);
  expect(approve).not.toHaveBeenCalled();

  const accepted = await handler(request({ requestId, taskVersion: 1, graphRevision: 1,
    taskFingerprint: fingerprint, approved: true }), taskId);
  expect(accepted.status).toBe(202);
  expect(approve).toHaveBeenCalledWith({ requestId, taskId, expectedTaskVersion: 1,
    graphRevision: 1, taskFingerprint: fingerprint, approved: true,
    actorWallet: "0x1111111111111111111111111111111111111111" });
});

it("fails closed while disabled or on a cross-origin request", async () => {
  const approve = vi.fn();
  const auth = { authenticateSession: vi.fn(async () => ({ walletAddress: "0x1111111111111111111111111111111111111111" })) };
  const disabled = createQueenPlanningApprovalHandler({
    enabled: false, authOrigin: new URL("https://agent-market.test"), auth, approve,
  });
  expect((await disabled(request({}), taskId)).status).toBe(503);
  const enabled = createQueenPlanningApprovalHandler({
    enabled: true, authOrigin: new URL("https://agent-market.test"), auth, approve,
  });
  expect((await enabled(request({}, "https://attacker.test"), taskId)).status).toBe(403);
  expect(auth.authenticateSession).not.toHaveBeenCalled();
  expect(approve).not.toHaveBeenCalled();
});
