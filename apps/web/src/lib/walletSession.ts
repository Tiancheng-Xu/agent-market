// Cookie writes stay ordered within this tab. Broadcasts carry invalidation only;
// they never carry identity, credentials, or permission to authenticate.
let revision = 0;
let pending: Promise<unknown> = Promise.resolve();
let needsAuthentication = true;
let cleanupRequired = false;
type SessionNotice = "invalidated" | "logout-failed";
const listeners = new Set<(notice: SessionNotice) => void>();
let channel: BroadcastChannel | undefined;
const seen = new Set<string>();
const notify = (notice: SessionNotice) => { for (const listener of listeners) listener(notice); };

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = pending.then(operation, operation);
  pending = result.catch(() => undefined);
  return result;
}

function invalidateLocal() {
  revision += 1;
  needsAuthentication = true;
  cleanupRequired = true;
  notify("invalidated");
}

function remember(eventId: string) {
  seen.add(eventId);
  if (seen.size > 64) seen.delete(seen.values().next().value!);
}

function broadcastInvalidation() {
  if (!channel) return;
  const eventId = crypto.randomUUID();
  remember(eventId);
  channel.postMessage({ type: "wallet-invalidated", version: 1, eventId });
}

function receiveInvalidation(event: MessageEvent<unknown>) {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  const message = data as Record<string, unknown>;
  if (Object.keys(message).sort().join(",") !== "eventId,type,version"
      || message.type !== "wallet-invalidated" || message.version !== 1
      || typeof message.eventId !== "string" || !/^[a-f0-9-]{36}$/i.test(message.eventId)
      || seen.has(message.eventId)) return;
  remember(message.eventId);
  invalidateLocal();
  // Never echo a received event back to another tab.
  void enqueue(logout).catch(() => undefined);
}

export function subscribeWalletSession(listener: (notice: SessionNotice) => void) {
  listeners.add(listener);
  if (!channel && typeof window !== "undefined" && typeof window.BroadcastChannel === "function") {
    channel = new window.BroadcastChannel("agent-market-wallet-invalidation-v1");
    channel.addEventListener("message", receiveInvalidation);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && channel) {
      channel.removeEventListener("message", receiveInvalidation);
      channel.close();
      channel = undefined;
    }
  };
}

async function logout() {
  const expected = revision;
  try {
    const response = await fetch("/api/auth/logout", {
      method: "POST", credentials: "include", signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/json" }, body: "{}",
    });
    if (!response.ok) throw new Error("AUTH_LOGOUT_UNAVAILABLE");
    cleanupRequired = false;
  } catch {
    cleanupRequired = true;
    needsAuthentication = true;
    if (expected === revision) notify("logout-failed");
    throw new Error("AUTH_LOGOUT_UNAVAILABLE");
  }
}

export function walletSessionRevision() { return revision; }

export function invalidateWalletSession(): Promise<void> {
  invalidateLocal();
  broadcastInvalidation();
  return enqueue(logout);
}

// This is a local veto, never server authorization. The protected HTTP endpoint
// must still authenticate its cookie on every request.
export function assertWalletSessionAuthenticated() {
  if (needsAuthentication || cleanupRequired) throw new Error("AUTH_REAUTH_REQUIRED");
}

export function withWalletSession<T>(operation: () => Promise<T>): Promise<T> {
  const expected = revision;
  return enqueue(async () => {
    if (expected !== revision) throw new Error("AUTH_WALLET_CHANGED");
    try {
      if (cleanupRequired) await logout();
      if (expected !== revision) throw new Error("AUTH_WALLET_CHANGED");
      const result = await operation();
      if (expected !== revision) throw new Error("AUTH_WALLET_CHANGED");
      needsAuthentication = false;
      return result;
    } catch (error) {
      if (expected === revision) {
        invalidateLocal();
        broadcastInvalidation();
      }
      await logout();
      throw error;
    }
  });
}
