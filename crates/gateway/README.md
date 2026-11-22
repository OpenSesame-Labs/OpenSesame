# opensesame-gateway

The Host API on `:8787`, served by `opensesame host run`, the centre of the
Host/authority plane. It runs the ConnectionRef → authorize → invoke → receipt
path, and hosts connections, tasks and intents, the sync blob store,
certificates and their issuers, event-driven backups, lifecycle and security
hooks, shared sessions, relayed execution, the operator transport routes and
signed provider callbacks (`POST /webhooks/{connection}/{route}`, mounted when
`OPENSESAME_CALLBACK_MASTER_KEY` is set; `src/callback_ingress`).
Agent-facing routes deal in `ConnectionRef` and intents, never raw secrets.

## Where it fits

- **Used by:** [`apps/cli`](../../apps/cli), [`crates/daemon`](../daemon) (proxy, mint
  passthrough), [`packages/mcp-host`](../../packages/mcp-host), [`packages/mcp-client`](../../packages/mcp-client),
  and [`apps/browser-extension`](../../apps/browser-extension) over HTTP; [`tests/mtls-interop`](../../tests/mtls-interop) runs `opensesame host run` as a process.
  The library exports `run`, `Args` and `cert_issuers`, plus an explicitly
  enabled testkit described below.
- **Builds on:** [`opensesame-host-core`](../../crates/host-core),
  [`opensesame-storage`](../../crates/storage) (SQLite),
  [`opensesame-connection-broker`](../../crates/connection-broker),
  [`opensesame-connector-host`](../../crates/connector-host),
  [`opensesame-task-bus`](../../crates/task-bus),
  [`opensesame-lifecycle`](../../crates/lifecycle),
  [`opensesame-security-events`](../../crates/security-events),
  [`opensesame-transport-security`](../../crates/transport-security) and the
  rest of `Cargo.toml`.
- No `getSecret()`: agent-facing APIs use ConnectionRef + Intent
  ([ADR 0005](../../docs/adr/0005-authority-handle-connectionref.md)). Deadlines
  publish on the `lifecycle.*` feed ([ADR 0074](../../docs/adr/0074-expiry-lifecycle-hooks.md));
  security facts go through `security::dispatch` ([ADR 0080](../../docs/adr/0080-security-event-hooks.md)).
  `src/run_lease.rs` applies ADR 0150 §6.2 to the runs the Host holds: every
  `agent.*` and `surrogate.*` notice on that feed is read against the run it
  names, a `surrogate.misdirected` parks a watched run, and a run whose agent
  stopped driving (or whose page a person took) has its credentials revoked
  through `AppState::run_credentials`.

## Surface

Flags (each also an env var): `--listen` (`OPENSESAME_LISTEN`, default
`127.0.0.1:8787`), `--resource` (`OPENSESAME_RESOURCE`), `--issuer`
(`OPENSESAME_ISSUER`), `--database-url` (`OPENSESAME_DB`), `--task-database-url`
(`OPENSESAME_TASK_DB`). Feature `wasm-connectors` (default off) enables the
community Wasm connector runtime; feature `bitwarden-compat` (default off)
compiles in the Bitwarden-compatible server, which `src/bitwarden_compat.rs`
mounts at `/bitwarden` only when `OPENSESAME_BITWARDEN_COMPAT=on`
([`opensesame-bitwarden-server`](../bitwarden-server)). Contract:
[`spec/openapi/host-api.yaml`](../../spec/openapi/host-api.yaml).

| Route group | Prefixes (bare names are under `/api/v1/`) |
|---|---|
| Health, discovery | `/health/*`, `/api/v1/health`, `/auth.md`, `/.well-known/agent-card.json`, `/.well-known/oauth-protected-resource`, `/api/v1/whoami` |
| Connections | `/api/v1/connections`, `providers`, `custom-providers`, `credential-providers`, `credential-connections`, `integrations`, `oauth/*` callbacks, `projects/{id}/configs`, `configs`, `delegations`, `attachments` |
| Authority | `/api/v1/tasks`, `intents`, `receipts`, `agent*` (incl. `agent/runs`, `agent-hooks`), `web-login`, `host-authorizations`, `ceremonies`, `organizations/{org}/grants`, `grant-offers` and `access-domains`, `/experimental/aauth/*` |
| Sessions, pairing | `/api/v1/session`, `sessions`, `shared-sessions`, `browser-pairings`, `browser-clients`, `device`, `/pair` |
| Sync, backup | `/api/v1/sync`, `sync-targets`, `backup`, `changelog`, `webhooks/github` |
| Certificates | `/api/v1/certs`, `/api/v1/certmgr/*`, `/.well-known/est/*` |
| Lifecycle, security | `/api/v1/lifecycle`, `rotations`, `security`, `a2h` |
| Relay, task bus | `/api/v1/relay`, `/api/v1/nats` |
| Operator | `/api/v1/operator/*` (incl. `operator/transport/*`), `/api/v1/admin` |
| KV v2 facade | `/v1/sys`, `/v1/{mount}`, only with `OPENSESAME_KV_FACADE` set to `true` or `1` |

Relay execution is temporarily unavailable: heartbeat, submission, executable
pending inbox delivery, approval, and result reporting return
`501 relay_execution_unavailable`. A holder runtime must independently
re-authorize at the effect boundary, and result acceptance needs a durable
transaction for the authority check and update. Existing requests may still be
inspected by ID or denied. A relay-only delegation cannot instead use the broker
invocation path, including a queued invocation or retry. Inspection exposes
only the ID, state and normalized
outcome; legacy summaries are withheld. This
cannot recall previously disclosed requests or cancel an external action
already in progress.

Broker-mode delegation is also temporarily unavailable: new broker-mode
offers and claims, and exercise of existing broker-mode delegations, return
`503 delegation_unavailable` or `503 delegated_execution_unavailable`.
An offer that omits `execution_mode` defaults to `broker` and is also refused.
Relay-mode offers can still be claimed, but cannot be exercised while relay is
disabled. Existing offers and delegations can be read and revoked, and
attenuating a live delegation remains available. Owner invocations continue
to use their existing path. A stored mode and its unkeyed manifest digest do
not independently authenticate which mode the owner approved. Restoration
requires an authenticated, versioned mode binding and migration of existing
delegations, as well as an effect-boundary fence. All Hosts that share authority
must run this restriction: an older Host can still execute delegated work.

Source areas under `src/`: `routes/` (one module per group), `middleware/`
(caller resolution, agent and browser grants), `transport/` and
`transport_lifecycle/` (mTLS admission, bindings, certificate lifecycle),
`cert_issuers/` (ACME, Cloudflare), `lifecycle/`, `security/`, `breach/`,
`backup*.rs`, `session_channel*`, `task_engine.rs`, `sync_actor.rs`, `config.rs`.

## Develop

### Test consumers against the Host

The `testkit` feature exposes `testkit::HostTestkit`: a fresh in-memory SQLite
database and synthetic operator token using the real Host router, including its
browser and agent admission middleware. No provider credentials, external
databases, NATS configuration, proxy credentials, or production signing keys
are loaded from the process. No background actors or outbound provider
integrations are started.

```toml
opensesame-gateway = { path = "../gateway", features = ["testkit"] }
```

```rust,no_run
use opensesame_gateway::testkit::HostTestkit;

let host = HostTestkit::new().await?;
let server = host.start().await?; // ephemeral 127.0.0.1 port
let base = server.base_url();
let operator = host.operator_token();
// Point a client at `base` with bearer `operator:<operator>`.
server.close().await?;
# Ok::<(), anyhow::Error>(())
```

`router()` offers the same handlers as an Axum service. It admits only
`GET /health/live`, `GET /health/ready`, `GET /api/v1/whoami`, and
`GET /api/v1/connections`; other routes and methods return 404. Connections
start empty, and no login or credential is fabricated. A new fixture provides
fresh state and a distinct token. `close().await` gives active requests 500 ms
to finish, cancels remaining connections, and returns an error if shutdown
cannot be confirmed within three seconds. Dropping the server initiates the
same shutdown without waiting; state lives until all fixture/router handles
are dropped.

This fixture does not test Host startup configuration, listener TLS, the
production CORS/security-header wrapper, session issuance, provider invocation,
durable storage, or background jobs. Run the real Host integration suites for
those behaviors. The API-client consumer test below additionally needs Node and
installed workspace dependencies.

```bash
cargo test -p opensesame-gateway
cargo test -p opensesame-gateway --features testkit --test testkit
cargo test -p opensesame-gateway --features testkit --test testkit typescript_api_client_exercises_the_real_host -- --ignored
cargo run -p opensesame-cli -- host run --listen 127.0.0.1:8787
npm run test:live-stack    # live OpenFGA / OpenBao / gateway
npm run test:mtls          # transport-security contract suites
```

A configuration refusal comes before SQLite or a listener starts:
`config::assert_cors_origins` and `config::StartupSecurity::load` run first in
`run` and `app_state::build`, and the secret checks are unit-tested in
`src/config.rs`. Response shapes are `insta` snapshots in
`src/routes/snapshots/`. A new route needs a
[`capability-registry`](../../packages/capability-registry) entry
([ADR 0065](../../docs/adr/0065-agent-surface-parity.md)).

## Related

- [ADR 0017](../../docs/adr/0017-host-client-product-topology.md), [ADR 0032](../../docs/adr/0032-connection-broker-service-integrations.md), [ADR 0039](../../docs/adr/0039-event-driven-github-backup.md), [ADR 0046](../../docs/adr/0046-relayed-execution-and-authorization-inbox.md), [ADR 0075](../../docs/adr/0075-host-certificate-key-custody.md), [ADR 0132](../../docs/adr/0132-optional-mtls-and-workload-identity.md)
- [Architecture: connection broker](../../docs/architecture/connection-broker.md), [transport topology](../../docs/architecture/transport-topology.md)
- [Operators: health and operations](../../docs/operators/health-and-operations.md), [mTLS](../../docs/operators/mtls.md), [security alerting](../../docs/operators/security-alerting.md)
