# opensesame-worker

The workload connector host on the Host/authority plane, served by
`opensesame worker run`. It exposes readiness and a provider listing; it
accepts no work and has no invocation endpoint.

## Where it fits

- **Run by:** [`apps/cli`](../../apps/cli) (`opensesame worker run`). The Host
  API probes its `mtls_required` listener as the `worker` hop
  (`OPENSESAME_WORKER_PROBE_ADDR`).
- **Builds on:** [`opensesame-connector-host`](../connector-host) (provider
  catalogue), [`opensesame-domain`](../domain),
  [`opensesame-transport-security`](../transport-security).
- The `mtls_required` profile reads no token at all, and refuses to start if
  its certificate material is missing; it never downgrades to
  `existing_local` ([ADR 0132](../../docs/adr/0132-optional-mtls-and-workload-identity.md)).

## Surface

`opensesame worker run`:

| Flag / variable | Meaning |
|---|---|
| `--id` | Worker id (default `worker-1`) |
| `--listen` / `OPENSESAME_WORKER_LISTEN` | Default `127.0.0.1:8790` |
| `--providers` / `OPENSESAME_WORKER_PROVIDERS` | Required, comma-separated provider ids this workload may host |
| `OPENSESAME_WORKER_TRANSPORT` | `existing_local` (loopback plus `OPENSESAME_WORKER_TOKEN` or `OPENSESAME_OPERATOR_TOKEN`) or `mtls_required` |
| `OPENSESAME_WORKER_TLS`, `OPENSESAME_WORKER_BINDINGS_FILE`, `OPENSESAME_WORKER_TLS_CLIENT_TRUST_PROFILE` | `mtls_required` material and service bindings |

`existing_local` accepts only a parsed loopback socket address. Wildcard, LAN,
and hostname binds fail closed. Use `mtls_required` for a network listener.

Routes: `GET /health/live`, `GET /health/ready`, `GET /v1/providers`.

## Integration-test workers

Enable the `testkit` feature on the worker as a **dev dependency**. The
testkit starts the same worker router and admission checks on an ephemeral
loopback listener; it does not set process environment or use shared state.
Every test should create its own instance and await `close()` so the port is
released. Dropping the handle initiates bounded shutdown as a fallback.

```toml
[dev-dependencies]
opensesame-worker = { path = "../worker", features = ["testkit"] }
```

```rust,no_run
# async fn example() -> anyhow::Result<()> {
use opensesame_worker::testkit::start_local;

let mut worker = start_local(&["encrypted-remote"], "test-only-token".into()).await?;
let client = reqwest::Client::builder().no_proxy().build()?;
let response = client
    .get(format!("{}/v1/providers", worker.base_url()))
    .bearer_auth("test-only-token")
    .send()
    .await?;
assert!(response.status().is_success());
worker.close().await?;
# Ok(())
# }
```

`start_mtls` instead creates a fresh in-memory test CA, a real mTLS listener,
and the caller's validated service bindings. It exposes `issue_client` and
`client` to exercise bound, unbound, missing or untrusted certificates. A
certificate alone grants nothing: the operation must appear in an explicit
binding. An empty binding set denies all service operations. See
[`tests/testkit.rs`](tests/testkit.rs) for examples including refusals and
shutdown. Bindings use the `CLIENT_TRUST_PROFILE` testkit constant. The
generated profiles do not test the CLI or the environment/file
loading of deployed identities; the existing worker transport tests cover those
paths separately.

Readiness uses the real provider probe after admission. To keep tests offline,
the fixtures accept only the built-in `encrypted-remote` provider: other
providers are rejected before a listener starts because their probes can
invoke locally installed CLIs or contact their services using ambient
credentials. Tests of those providers need a separately controlled environment.
The testkit creates no emulated task execution or provider service, because the
worker itself only exposes readiness and provider listing.

## Develop

```bash
cargo test -p opensesame-worker
cargo test -p opensesame-worker --features testkit
cargo run -p opensesame-cli -- worker run --help
```

## Related

- [ADR 0132](../../docs/adr/0132-optional-mtls-and-workload-identity.md) — optional mTLS
- [ADR 0138](../../docs/adr/0138-self-issued-identity-one-native-host.md) — one native binary
