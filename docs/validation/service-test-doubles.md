# Service test doubles

Use the narrowest real boundary that answers the test's question. A **stub**
returns explicitly arranged responses; a **fake** has a working but simplified
implementation; a **protocol stand-in** speaks a specified subset of the wire
protocol; an **emulator** is useful only to the extent its documented behavior
matches the service. These names are not evidence of full compatibility.

The common service interface is the actual interface consumed in production:
for example `fetchImpl`, `ChannelAdapter`, `TaskBus`, or `Repositories`. A
different service has a different interface. TypeScript test resources that
need cleanup expose `close()` and may be registered with
`@opensesame/testing`'s `withTestResources` / `TestResourceScope`. Fresh
instances are preferred to sharing state; reset is useful only where its
semantics are explicitly defined. Rust testkits use the crate's real trait and
feature flags, and Rust ownership handles resource cleanup where possible.
Use `scope.acquire(() => startService())` to track concurrent starts before
they begin; `scope.use(await startService())` is for sequential setup.

## Available counterparts and limits

| Boundary | Local counterpart | What still needs a real service |
|---|---|---|
| Host API | [`@opensesame/api-client/testkit`](../../packages/api-client/README.md#scripted-host-http-stub) scripts responses through the client's real `fetchImpl`. | The stub has no gateway, authentication, authorization, storage, DPoP or TLS. Use gateway and live-stack tests. |
| Local daemon | [`DaemonTestkit`](../../crates/daemon/README.md#test-the-daemons-local-routes) runs selected production routes with isolated in-memory state and an operator token. | Real sign-in, discovery, proxying, credential fill, persistence and OS peer identity require their existing integration tests. |
| Identity API | [`@opensesame/identity-testkit`](../../packages/identity-testkit/README.md) starts the real Identity HTTP dispatcher and issuer with memory-backed state. | Production Postgres, external providers, TLS and hardware; see its README for process-global limitations. |
| Upstream identity | [`@opensesame/mock-upstream-idp/testkit`](../../tools/mock-upstream-idp/README.md) serves signed local OIDC/SAML and selected OAuth2 flows, and drives a PKCE grant for real token consumers; an LDAP stand-in is also provided. | Individual real IdP policies, account recovery, passkey authenticators and deployment configuration. The fixture auto-approves a synthetic user. |
| Identity storage | [`MemoryRepositories`](../../packages/database/README.md) implements repository ports; the [identity repository contract](../../packages/database/tests/identity-repository-contract.test.ts) also runs against migrated PGlite or a disposable Postgres database. | Real Postgres driver, migrations, locking and concurrency; run `test:postgres`. Memory and PGlite are not substitutes for these checks. |
| Host storage | [`Db::connect_memory`](../../crates/storage/README.md) uses in-memory SQLite and the real storage interface. | File durability, filesystem permissions, crash recovery and multi-process contention. |
| Native TaskBus | [`InMemoryTaskBus` and `ScriptedTaskBus`](../../crates/task-bus/README.md#testing-consumers) implement `TaskBus`; the latter can inject failures. | NATS JetStream persistence, deduplication, redelivery, server configuration and TLS; run the live-server suites. |
| Identity worker TaskBus | [`MemoryTaskBus` and `createTestTaskBus`](../../packages/identity-worker/README.md#taskbus-test-double) use the worker's `TaskBus` port; the latter scripts failures. | NATS stream guarantees, durability and network behavior. |
| Workload connector host | [`opensesame_worker::testkit`](../../crates/worker/README.md#integration-test-workers) runs the real local-token or mTLS router on loopback with isolated test credentials. | Deployed certificate and environment loading, external providers, and live service behavior. The fixture accepts only the offline-safe `encrypted-remote` provider. |
| Notifications | [`@opensesame/identity-worker/testkit`](../../packages/identity-worker/README.md) supplies a scripted channel at the worker port. [`startPushStandIn` and `createSlackStandIn`](../../packages/notification-adapters/README.md) exercise the actual adapters with Web Push cryptography and signed Slack callbacks. | Actual provider delivery, callback provenance and availability; the channel double does not settle requests, and the Slack stand-in implements only selected operations. |
| Workload identity, STS | [`fake-workload-api`](../../crates/spiffe-source/README.md) and the [STS stand-in](../../crates/connection-broker/src/aws_sts/stand_in.rs) cover selected protocols. | Real SPIFFE infrastructure, IAM policy, AWS behavior and deployment transport. |
| Support agent | [`createFakeSupportAgent`](../../packages/support-agent/README.md) implements the support port with scripted results. | Actual model/runtime behavior and provider availability. |
| OpenBao authority | [`MemoryAuthority`](../../crates/provider-openbao/src/lib.rs) is a simplified local stand-in. | Signing, decryption and revocation semantics: it echoes input for sign/decrypt and revocation is a no-op. It is not cryptographic evidence. |

This is an inventory of service boundaries, not a claim that every endpoint
is emulated. The daemon and worker fixtures expose selected real routes; use
their existing component fixtures and real-process tests for the rest. Client
libraries, pure domain, policy, format and cryptographic packages should
normally run their actual implementation with dependency ports faked only when
useful.

## Adding or maintaining a double

1. Identify the consumer and the production interface it already uses. Prefer
   an existing fake or an isolated instance of the real service. Keep test
   code in a test-only package, an explicit `testkit` / `test-support` entry
   point, or a Rust feature; do not add a runtime switch that bypasses security
   checks.
2. State the subset of operations and failures, state lifetime and reset,
   concurrency assumptions, and unmodeled guarantees. Isolate credentials,
   ports, files and environment; use synthetic data. Do not open a network
   connection as a fallback for an unmatched request.
3. Test at least one actual consumer through the same interface. Cover useful
   refusals, failures and isolation as well as success. Where a fake claims
   parity, run the same behavioral contract against both implementations;
   keep the real-service integration suite for transactions, timing,
   cryptography, authentication and other unsupported behavior.
4. If generating scaffolding or fixtures, use the checked-in OpenAPI or other
   authoritative contract as input, record the generator and version, and
   provide a reproducible regeneration/drift check. Review generated changes
   and update behavior tests with every service contract change. A generated
   schema or canned response does not prove behavior.
5. Update this inventory and the owning package's README, including the exact
   tests needed for fidelity claims. Remove or correct a double that drifts
   instead of expanding a fake's claims to match its implementation.

For authentication, a local IdP and a local instance of the real issuer are
useful: they let tests cover token verification, expiry, rejection and session
flows without a third-party account. A stubbed `200 OK` cannot establish any
of those properties. Keep negative and real integration tests at the relevant
trust boundary.
