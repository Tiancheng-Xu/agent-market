import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRiskQuoteSession, LiveRiskQuotePanel } from "../components/LiveRiskQuotePanel";

const funding = { quoteId: "quote-1", taskFingerprint: "fingerprint-1" };
const expiresAt = "2026-09-09T12:00:01.000Z";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-09T12:00:00.000Z")); });
afterEach(() => { vi.useRealTimers(); });

function setup() {
  const notify = vi.fn();
  const expire = vi.fn();
  const session = createRiskQuoteSession(notify, expire);
  session.activate();
  return { session, notify, expire };
}

describe("risk quote panel session lifetime", () => {
  it("revokes funding at the expiry boundary without another render or request", () => {
    const { session, notify, expire } = setup();
    const token = session.begin();
    session.watchExpiry(expiresAt);
    expect(session.publish(token, expiresAt, funding)).toBe(true);
    vi.advanceTimersByTime(999);
    expect(notify).toHaveBeenLastCalledWith(funding);
    vi.advanceTimersByTime(1);
    expect(notify).toHaveBeenLastCalledWith(null);
    expect(expire).toHaveBeenCalledOnce();
    expect(session.publish(token, expiresAt, funding)).toBe(false);
  });

  it("revokes readiness immediately when a new operation starts", () => {
    const { session, notify } = setup();
    session.publish(session.begin(), expiresAt, funding);
    session.begin();
    expect(notify).toHaveBeenLastCalledWith(null);
  });

  it("rejects an old async result after a newer request", async () => {
    const { session, notify } = setup();
    const oldToken = session.begin();
    const pending = Promise.resolve().then(() => session.publish(oldToken, expiresAt, funding));
    const newToken = session.begin();
    expect(await pending).toBe(false);
    expect(session.isCurrent(newToken)).toBe(true);
    expect(notify).toHaveBeenLastCalledWith(null);
  });

  it("keeps expiry active while a confirmation is pending", () => {
    const { session, notify, expire } = setup();
    session.watchExpiry(expiresAt);
    const confirmationToken = session.begin();
    vi.advanceTimersByTime(1000);
    expect(session.isCurrent(confirmationToken)).toBe(false);
    expect(expire).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenLastCalledWith(null);
  });

  it("rejects a delayed success even before a throttled expiry timer runs", () => {
    const { session, notify } = setup();
    const token = session.begin();
    vi.setSystemTime(new Date(expiresAt));
    expect(session.publish(token, expiresAt, funding)).toBe(false);
    expect(notify).toHaveBeenLastCalledWith(null);
  });

  it("clears the parent and ignores outstanding work on unmount or scope change", () => {
    const { session, notify, expire } = setup();
    const token = session.begin();
    session.watchExpiry(expiresAt);
    session.publish(token, expiresAt, funding);
    session.dispose();
    expect(notify).toHaveBeenLastCalledWith(null);
    expect(session.publish(token, expiresAt, funding)).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(expire).not.toHaveBeenCalled();
  });

  it("cannot revive pre-cleanup requests after Strict Mode effect reactivation", () => {
    const { session } = setup();
    const token = session.begin();
    session.dispose();
    session.activate();
    expect(session.publish(token, expiresAt, funding)).toBe(false);
    expect(session.publish(session.begin(), expiresAt, funding)).toBe(true);
  });

  it("replaces the previous quote expiry timer", () => {
    const { session, expire } = setup();
    session.watchExpiry(expiresAt);
    session.watchExpiry("2026-09-09T12:00:03.000Z");
    vi.advanceTimersByTime(1000);
    expect(expire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(expire).toHaveBeenCalledOnce();
  });

  it("fails closed for invalid expiry and does not overflow long timers", () => {
    const { session, expire } = setup();
    expect(session.publish(session.begin(), "invalid", funding)).toBe(false);
    session.watchExpiry("2099-01-01T00:00:00.000Z");
    vi.advanceTimersByTime(1000);
    expect(expire).not.toHaveBeenCalled();
    session.watchExpiry("invalid");
    expect(expire).toHaveBeenCalledOnce();
  });

  it("isolates task and wallet changes using a fresh component identity", () => {
    const props = { taskId: "task-1", walletAddress: "wallet-1", onFundingReady: vi.fn() };
    const initial = LiveRiskQuotePanel(props).key;
    expect(LiveRiskQuotePanel({ ...props, taskId: "task-2" }).key).not.toBe(initial);
    expect(LiveRiskQuotePanel({ ...props, walletAddress: null }).key).not.toBe(initial);
  });

  it("explains all eight factors without inventing individual scores", () => {
    const markup = renderToStaticMarkup(createElement(LiveRiskQuotePanel, { taskId: "task-1", walletAddress: null, onFundingReady: vi.fn() }));
    for (const label of ["Complexity", "Acceptance ambiguity", "External dependency", "Data sensitivity", "Financial risk", "Irreversibility", "Deadline risk", "Agent uncertainty"]) expect(markup).toContain(label);
    expect(markup).toContain("Individual scores are not provided");
  });
});
