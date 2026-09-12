# W7 caller follow-up after independent review

Targeted completion only; no claim that all W7 requirements are complete.

## Security semantics

- orderClient read and command requests check authenticated state and revision before fetch, after response headers, and after body parsing, including failed responses. Logout 503 never implies cookie deletion. A new login cannot make an old in-flight response current.
- sendTransactionIntent checks authenticated revision, provider instance, accounts and Sepolia chain before sending. Accounts are read again after chain read to reject silent account changes. The request explicitly binds chainId to Sepolia. Temporary account/chain/disconnect listeners catch changes even when final identity returns to its initial value and are removed in finally.
- A preflight failure makes zero eth_sendTransaction calls. Once the provider has been called, errors, malformed hashes or identity changes produce TransactionSubmissionUncertainError. Its code and submission fields mark uncertainty. reference retains only the original intentId, requestId, requested chainId, originalSender and a validated txHash when available. No new wallet is substituted. No automatic retry is implemented.
- A returned hash is a submission reference, never chain confirmation, successful execution or settlement. The reference chainId is the intended chain, not proof that an unknown provider obeyed it. The safe intent/hash reference also appears in the error message for existing error-display callers.
- The actual UUID /tasks/:id route already had explicit signature login. OrderDetailRoute now subscribes to invalidation, clears its query cache, returns to login even if the wallet prop remains unchanged, and rejects obsolete login completions.

## Results

| Gate | Result |
| --- | --- |
| Mock transaction preflight and uncertain submission | 15/15 |
| Existing chain conversion/intent tests | 3/3 |
| Delayed order response revision tests | 2/2 |
| Existing order command contracts | 2/2 |
| Actual auth HTTP + actual order callers | 1/1 |
| Order route query ownership and initial login gates | 3/3 |
| Isolated browser UUID route login/recovery | 6/6 |
| Browser page exceptions | 0 |
| Web typecheck | passed |

[Sanitized tests](tests.sanitized.json), [browser matrix](order-route-browser.json), [source hashes](source-hashes.json).

The order caller and stale-response tests failed before their guard implementation. A targeted silent-account-change test also failed before the final account readback was added.

## HTTP fixture detail

Actual existing auth challenge/verify/logout factories and WalletAuthService run over a local TCP HTTP fixture with MemoryAuthStore and injected revoke failure. Protected fixture order endpoints invoke that real session authentication service and return schema-valid fixture snapshots; production order business handlers are not claimed as tested here. The actual readOrder and executeOrderCommand functions refuse the cookie that the fixture server still accepts after logout 503. The same mock account remains selected. On recovery the old server session is revoked, a fresh login is required, and actual readOrder succeeds again. The explicit in-memory cookie jar does not prove browser Secure/HttpOnly enforcement.

## Browser route detail

Actual OrderDetailRoute and OrderDetailPage are mounted on a UUID route with a fixed connected wallet prop. Initial state offers signature login without protected reads. Mock login loads the order page. Logout failure returns to an enabled retry entry, failed cleanup signs nothing and reads no order, recovery permits fresh login and reads, and a delayed invalidated signature cannot reopen the order. Wallet provider and HTTP replies are mocked in this browser run.

[Initial login screenshot](initial-login.png) and [logout failure retry screenshot](logout-failed-login.png) show the isolated functional harness without the product stylesheet; no visual-design acceptance is claimed.

## Boundary and gaps

No external/user wallet signature, real transaction, deployed service, real chain confirmation or settlement was performed. Transaction tests mock eth_sendTransaction; HTTP auth tests use only a disposable software test signature. Real external signing and real provider behavior remain unverified. Uncertain submission requires manual verification using the original reference; durable reconciliation and transaction UI redesign are outside this change. No parent risk file, Queen client, LocalAgentsPage or governance client was changed.

## Reproduce

From apps/web:

```sh
./node_modules/.bin/vitest run src/lib/chainClient.send.test.ts src/lib/chainClient.test.ts src/lib/orderClient.session.test.ts src/lib/orderClient.test.ts src/lib/walletSession.http.test.ts src/pages/OrderDetailRoute.session.test.tsx
./node_modules/.bin/tsc -p tsconfig.json --noEmit
```

Dedicated headless Chrome and Vite were shut down; both dedicated ports are closed. Parent browser/CDP was untouched. Archived JSON excludes addresses, credentials, signatures, raw logs and private absolute paths. Only a minimal sanitized summary is mirrored into public/evidence; no deployment was run.
