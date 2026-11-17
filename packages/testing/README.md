# @opensesame/testing

Shared test utilities for the TypeScript workspace: sentinel secret values
that must never appear in logs, traces or audit metadata, and the PACT
(Property / Adversarial / Chaos / conTract) helpers the other packages' suites
are written with. It is a dev dependency only; no production code imports it.

## Where it fits

- **Used by:** the test suites of most apps and packages — among them [`packages/control-plane`](../../packages/control-plane), [`packages/mcp-host`](../../packages/mcp-host), [`packages/mcp-client`](../../packages/mcp-client), [`packages/app-core`](../app-core), [`packages/policy`](../policy), [`packages/sdk-browser`](../sdk-browser), [`tests/redteam`](../../tests/redteam) and [`tests/fuzz/jazzer`](../../tests/fuzz/jazzer).
- **Builds on:** [`@opensesame/os-domain`](../os-domain) (types only).
- Diagnostic logs are separate from the audit trail; the sentinel scan is how a test proves a secret reached neither ([ADR 0015](../../docs/adr/0015-audit-vs-diagnostic-logging.md)).

## Surface

| Export | What it checks |
|---|---|
| `sentinelValues`, `assertNoSentinels(haystack)` | Throws if any `*_TESTSECRET` sentinel (claim secret, device code, refresh token, authorization code) appears in a string |
| `countConcurrentWins`, `assertExclusiveClaim`, `assertAtMostWins` | Property: run a worker 32 times concurrently; exactly one, or at most N, may succeed |
| `checkThenSetAdmitsDoubleClaim` | The naked read-then-write mutant, kept to show why production must not use it |
| `assertSourceOrder(src, markers)` | Mutation oracle: markers appear in order in the production part of a source file (before `#[cfg(test)]` or the first `describe(`) |
| `assertNoSecretFields(value, allow)` | Contract: a JSON body carries no `access_token`, `refresh_token`, `client_secret`, `webhook_secret`, `private_key`, `claim_token` / `claimToken` |
| `assertFailClosedStatuses(responses, required)` | Contract: an OpenAPI responses object documents the fail-closed statuses (default `401`) |
| `assertDurableSurvivesPartition(count, publish)` | Chaos: durable work is still present after a failed publish |
| `startEphemeralPostgres()`, `PINNED_POSTGRES_IMAGE` | Integration: disposable Postgres via Testcontainers when Docker is available |
| `TestResource`, `TestResourceScope`, `withTestResources` | Manage test-service lifecycles; close acquired resources in reverse order, including on failure |
| `freePort`, `onFreePort`, `listenOnLoopback` | Start loopback test services and retry when an ephemeral port is taken before binding |

The loopback helpers are also available from `@opensesame/testing/ports`,
which does not load the optional Postgres test-container dependencies.

## Service lifecycles

Test services may implement `TestResource` structurally by exposing `close()`;
they need not depend on this package. `withTestResources` closes everything
registered before setup or the test fails, and preserves both the test and
cleanup errors if both fail. Create a scope per test, and register each
resource immediately after it starts:

```typescript
import { withTestResources } from "@opensesame/testing";
import { startReferenceIdp } from "@opensesame/mock-upstream-idp/testkit";

await withTestResources(async (scope) => {
  const idp = scope.use(await startReferenceIdp());
  // Exercise the consumer using idp.issuer.
});
```

For concurrent startup, register each operation before awaiting it with
`scope.acquire(() => startService())`. The scope then waits for outstanding
starts and closes any that finish after another start or the test fails.
Use `scope.use(await startService())` for sequential startup only; the scope
cannot track a promise it has not been given.

The lifecycle interface does not replace a service's own API or imply
behavioral parity. See [service test doubles](../../docs/validation/service-test-doubles.md)
for available implementations and their limits.

When an issuer must know its port before starting, `onFreePort(bind)` obtains
a loopback port and retries `bind(port)` only if another process took it before
the bind. `freePort()` alone does not reserve the returned port; use the retrying
helper when starting a listener. Socket permission and other errors propagate.

## Postgres integration tests

When a suite needs real Postgres (not PGlite), prefer
`startEphemeralPostgres()` from this package. It uses a digest-pinned
`postgres:16-alpine` image. Skip the suite when Docker is unavailable rather
than falling back to ad-hoc compose scripts.

```typescript
import { startEphemeralPostgres } from "@opensesame/testing";

const postgres = await startEphemeralPostgres();
process.env.DATABASE_URL = postgres.databaseUrl;
try {
  // run migrations and assertions
} finally {
  await postgres.close(); // stop() remains an alias
}
```


```bash
npm run test -w @opensesame/testing
npm run test:security -w @opensesame/testing   # src/security.test.ts only
npm run typecheck -w @opensesame/testing
npm run test:security                                # the same, from the root
```

The package's own suite also holds one repository check that is not about
these helpers: `fuzz-toolchain.test.ts` (nightly-pinned `cargo fuzz` in the
fuzz scripts).

## Related

- [PACT](../../docs/validation/pact.md) — the validation method these helpers implement
- [ADR 0015](../../docs/adr/0015-audit-vs-diagnostic-logging.md) — audit vs diagnostic logging
