# @opensesame/identity-worker

The Identity-plane background loop: it drains the outbox onto the TaskBus,
fans out webhooks and notifications, and prunes the issuer's expired rows.
The Host plane's workload connector host is a different thing, served by
`opensesame worker run` from [`crates/worker`](../../crates/worker).

## Where it fits

- **Used by:** the root `npm run dev` starts it. Nothing in the workspace
  imports the package.
- **Builds on:** [`@opensesame/database`](../../packages/database)
  (repositories, Drizzle, the OIDC store), [`@opensesame/webhooks`](../../packages/webhooks),
  [`@opensesame/claims`](../../packages/claims) (the `ClaimEngine` type; the
  worker process is not handed one),
  [`@opensesame/notification-adapters`](../../packages/notification-adapters)
  (Web Push delivery),
  [`@opensesame/observability`](../../packages/observability), and the `nats`
  client for JetStream.
- It refuses to start without `DATABASE_URL`. Claim,
  session and project expiry run in the control plane's process, not here.
- With `OPENSESAME_TASKBUS=nats` (or `NATS_URL` set) it publishes to
  `opensesame.events.{type}` on JetStream and never falls back to core NATS.
  The Host owns the `OPENSESAME_EVENTS` stream.

## Surface

`src/index.ts`: `runCleanupTick`, `startCleanupLoop`;
`routeNotification`, `deliverNotifications`, `retractNotifications`;
`consumeRotationEvents` and the `credential.rotation.*` event names;
`MemoryTaskBus`, `createTaskBusFromEnv` and `NatsCoreTaskBus` (a deprecated
alias of the JetStream publisher, `NatsJetStreamTaskBus`). Environment:
`DATABASE_URL` (required), `OPENSESAME_WORKER_INTERVAL_MS` (default `5000`),
`OPENSESAME_TASKBUS`, `NATS_URL`; Web Push (`OPENSESAME_WEBPUSH_PUBLIC_KEY`,
`_PRIVATE_KEY`, `_SUBJECT`: none without a private key, refuse to start with an
unusable one; see
[operators: notification channels](../../docs/operators/notification-channels.md#web-push)).

## Notification test double

`@opensesame/identity-worker/testkit` exports `createTestChannelAdapter`, an
in-process implementation of the worker's `ChannelAdapter` port. Each
instance has independent `rendered`, `sent` and `updated` recordings, returns
the domain catalogue's capabilities, and can be passed directly to
`registryFromAdapters`. By default a send succeeds. Provide a delivery script
to exercise retries or permanent failures:

```typescript
import { registryFromAdapters } from "@opensesame/identity-worker";
import { createTestChannelAdapter } from "@opensesame/identity-worker/testkit";

const channel = createTestChannelAdapter("slack", {
  deliveryScript: [
    { ok: false, retryable: true, error: "status 503" },
    { ok: true, providerMessageRef: "accepted-after-retry" },
  ],
});
const adapters = registryFromAdapters([channel]);
// Pass adapters to the worker's notification dispatcher; inspect channel.sent.
channel.reset(); // clears recordings and rewinds the script
await channel.close(); // clears recordings and prevents further use
```

A script consumes one result or thrown `Error` per send and throws if
exhausted. Each instance may also be configured to refuse configuration,
throw on rendering or updating, or omit update support. Rendering is a
conservative placeholder at every confidentiality level: it returns the event
type and requested level, never fields from the input payload. Recordings do
retain inputs for assertions, so supply test data only. This double is not a
provider emulator, does not send messages or verify callback provenance, and
cannot establish that a real provider's rendering or privacy controls work. For Web Push's
cryptographic and transport checks, use the independent stand-in from
`@opensesame/notification-adapters/test-support` instead.

## TaskBus test double

The same testkit exports `createTestTaskBus`, which implements the worker's
`TaskBus` port and delegates successful publishes to `MemoryTaskBus`. Each
instance records every `attempts` event and every accepted `published` event.
Pass it to `runCleanupTick` to exercise outbox failure and retry:

```typescript
import { createTestTaskBus } from "@opensesame/identity-worker/testkit";

const taskBus = createTestTaskBus({
  publishScript: [new Error("unavailable"), "success"],
});
// Inject taskBus into runCleanupTick alongside the test's repositories and clock.
// The first tick leaves its outbox entry unpublished; the next can publish it.
taskBus.reset(); // clears recordings and rewinds the script
await taskBus.close(); // clears recordings and prevents further use
```

Without a script, publishes succeed. A script consumes one `Error` or
`"success"` per attempt and throws when exhausted; failures do not reach the
memory bus. The double opens no network connection and does not model
JetStream acknowledgements, persistence, deduplication, permissions or
distributed delivery. In-memory outbox tests also do not prove Postgres
durability. Use `npm run test:nats-dogfood` and Postgres integration tests for
those boundaries.

## Develop

```bash
npm run dev -w @opensesame/identity-worker          # tsx watch src/main.ts
npm run start -w @opensesame/identity-worker
npm run typecheck -w @opensesame/identity-worker
npm run test -w @opensesame/identity-worker         # vitest, src/**/*.test.ts
DATABASE_URL=postgres://… npm run test:postgres -w @opensesame/identity-worker  # Web Push tick on a real Postgres
npm run test:nats-dogfood                        # real nats-server
```

## Related

- [ADR 0042](../../docs/adr/0042-nats-taskbus-auth-callout-and-xkeys.md) — NATS TaskBus
- [ADR 0046](../../docs/adr/0046-relayed-execution-and-authorization-inbox.md) — authorization-request inbox webhooks
- [ADR 0084](../../docs/adr/0084-external-authorization-notifications.md) — external notifications
- [Architecture: task bus over NATS](../../docs/architecture/task-bus-nats.md), [operators: notification channels](../../docs/operators/notification-channels.md)
