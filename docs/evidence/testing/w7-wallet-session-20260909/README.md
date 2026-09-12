# W7 wallet-session targeted follow-up

Status: targeted gates passed; **not full W7 requirements completion**.

## Evidence boundary

Browser tests use **Mock EIP-1193**, with no real user/external wallet signature and no real transaction. The HTTP integration fixture runs the actual challenge, verify, and logout route factories plus WalletAuthService over a local TCP HTTP server. It uses an ephemeral software EIP-191 test signature and an in-memory AuthStore with injected revoke failure. This is cryptographic fixture validation, not a real wallet approval or production Gateway result. Cookie transport is an explicit in-memory jar; browser Secure/HttpOnly policy is not proven by it.

## Changes

- walletSession: BroadcastChannel invalidation event only (type, protocol version, random event ID); self/duplicate suppression; no forwarding of received events; channel listener and channel removed on last unsubscribe. No address, session, cookie or signature broadcast.
- useWallet: local and remote invalidation immediately clear UI identity. Failed logout reports that server deletion was not confirmed.
- chainClient: invalidation locally vetoes protected HTTP requests until server login verification succeeds; server endpoints must still authenticate each request. A changed revision discards late protected responses.
- Failed cleanup is retried before the next login; successful logout alone cannot authorize protected calls.

## Gates

| Gate | Result | Evidence |
| --- | --- | --- |
| New HTTP + channel cases and existing walletSession regressions | 5/5 | [targeted tests](followup-tests.sanitized.json) |
| Two isolated Chrome tabs using real BroadcastChannel | 9/9 | [browser checks](cross-tab-browser.sanitized.json) |
| Browser page exceptions | 0 | browser checks |
| Web tsc --noEmit | exit 0 | direct local command |
| Historical W7 browser checks | 17/17, not rerun | [prior browser](prior-browser.sanitized.json) |
| Historical wallet integration checks | 24/24, not rerun | [prior tests](prior-tests.sanitized.json) |

## HTTP chain checked

1. Stable mock-provider login passes actual auth verification and creates a cookie.
2. Injected logout store failure returns 503 without a cookie-deletion header. UI receives invalidation and logout-failed notices. The old cookie remains valid on the server, which is explicitly asserted.
3. The client refuses a protected call using stale identity and refuses login while cleanup still fails.
4. Retrying logout after store recovery clears the cookie and revokes the old server session. Presenting that old cookie, even with a forged client-authenticated header, yields 401.
5. Protected client calls remain blocked until fresh challenge/sign/verify succeeds; the recovered protected endpoint authenticates the new cookie server-side.

## Browser chain checked

Both tabs connect; tab B holds an unfinished connection. Tab A emits invalidation with logout returning 503. Both UIs clear; B's delayed result cannot restore identity. Only the invalidation metadata is broadcast and B does not echo it. Both tabs block the old protected session. Retried logout grants no client authentication. Unmounting B closes its channel and removes provider listeners; later events do not change its revision.

[Screenshot: failed logout, identity cleared](logout-failed-ui.png) is a dedicated hook-state harness, not the full product UI. [Prior unavailable-provider screenshot](prior-provider-unavailable.png) is historical. Both contain null identity values only.

## Reproduce targeted integration checks

From apps/web:

```sh
./node_modules/.bin/vitest run src/lib/walletSession.http.test.ts src/lib/walletSession.crossTab.test.ts src/lib/walletSession.test.ts
./node_modules/.bin/tsc -p tsconfig.json --noEmit
```

## Remaining gaps

Real external/user wallet approval and signing remain unverified. No real transaction, deployed Gateway/database recovery, browser Secure-cookie policy, cross-browser compatibility or full W7 product gate is claimed. BroadcastChannel requires browser support; a storage-event fallback is not implemented. Cross-tab ordering can conservatively revoke a concurrent new login and require reauthentication; it is not a distributed cookie-write lock. Direct HTTP requests remain subject to server authentication; client state is never server authorization.

## Sanitization and publication

Only case names, boolean results, counts and non-identifying screenshots are archived. Wallet values, session/cookie/signature values, absolute private paths and raw browser logs are excluded. A minimal public summary and non-identifying screenshot are mirrored under apps/web/public/evidence/testing/w7-wallet-session-20260909. No deployment or publication command was run.

Cleanup verified: the dedicated Vite server and headless Chrome exited; both dedicated ports are closed. Parent browser/context was untouched.
