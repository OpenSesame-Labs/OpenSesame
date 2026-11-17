# opensesame-provider-openfga

The OpenFGA remote PDP adapter for the Host / authority plane: an HTTP client
against a live OpenFGA server, and the mapping from a Host `Grant` onto OpenFGA
relationship tuples. When `OPENSESAME_OPENFGA_URL` is unset, callers may fall
back to the in-process PEP. A projected tuple is never itself authority.

## Where it fits

- **Used by:** [`crates/gateway`](../../crates/gateway) (`src/openfga_project.rs`
  projects each grant under the authority writer lease; app state and intent
  projection) and the fuzz crate [`tests/fuzz/cargo`](../../tests/fuzz/cargo)
  (`openfga_response`).
- **Builds on:** [`opensesame-domain`](../domain) (`Grant`); `reqwest`.
- The PDP base URL must be https or loopback http, with no userinfo, query or
  fragment (`assert_pdp_base_url`). A configured store ID is a single
  URL-safe path segment. Invalid configured values refuse Host startup;
  an absent or blank URL leaves the PDP unconfigured.
- The HTTP client refuses redirects on every operation; a response from a
  different endpoint cannot be accepted as an authorization decision.
- A grant the mapping refuses is left unprojected, so the gateway's freshness
  check stays fail-closed.

## Surface

| Item | Role |
|---|---|
| `OpenFgaClient::from_env` | Reads `OPENSESAME_OPENFGA_URL` and `OPENSESAME_OPENFGA_STORE_ID` (required once the URL is set); `None` when the URL is unset |
| `OpenFgaClient` | `health`, `create_store`, `write_authorization_model`, `write_tuples`, `check_tuple`, `connection_model` |
| `RemotePdp`, `TupleKey` | The `check` trait and its tuple |
| `grant_to_openfga_tuples`, `invoke_check_tuple`, `GrantTupleMappingError`, `GrantTupleMappingResult` | Grant-to-tuple projection and the check tuple for an invocation |
| `parse_check_response`, `assert_pdp_base_url` | Response parsing and URL guard |
| `bootstrap_demo_store` | Creates an `opensesame-demo` store for live scripts and tests |
| `OpenFgaError`, `Result` | Error type |

## Remote PDP test double

Enable the `testkit` feature as a dev dependency to use `FakeRemotePdp`. It
implements the same `RemotePdp` check port that the gateway uses after its
projection-freshness fence. A new instance denies every check; `allow` and
`revoke` change only the exact user, relation and object supplied. Empty tuple
fields are errors. `set_unavailable(true)` makes checks return an error;
restoring availability retains the seeded tuples. `reset` clears them and
restores availability, while `close` clears and permanently closes the fake.
Clones share state, so create a fresh instance for each independent test.

```rust,no_run
# async fn example() -> opensesame_provider_openfga::Result<()> {
use opensesame_provider_openfga::{testkit::FakeRemotePdp, RemotePdp, TupleKey};

let pdp = FakeRemotePdp::new();
let tuple = TupleKey {
    user: "user:alice".into(),
    relation: "user".into(),
    object: "connection:example".into(),
};
assert!(!pdp.check(&tuple).await?);
pdp.allow(&tuple)?;
assert!(pdp.check(&tuple).await?);
pdp.close()?;
# Ok(())
# }
```

This is an exact-match fake, not an `OpenFGA` server: it does not interpret the
authorization model, infer inherited relations or usersets, expand wildcards,
evaluate conditions, model consistency or stores, or exercise HTTP and TLS.
An absent exact tuple can still be allowed by a real model through other
relationships. The fake does not replace live model, projection-freshness, or
transport tests. The gateway's production projector and health probe continue
to use the real `OpenFgaClient`.

## Develop

```bash
cargo test -p opensesame-provider-openfga
cargo test -p opensesame-provider-openfga --features testkit
# The live check is #[ignore]d and needs a running OpenFGA
OPENSESAME_OPENFGA_URL=http://127.0.0.1:8080 \
  cargo test -p opensesame-provider-openfga -- --ignored
npm run test:live-stack   # live OpenFGA/OpenBao/gateway
```

The authorization model and baseline tuples live in
[`spec/openfga`](../../spec/openfga).

## Related

- [ADR 0002](../../docs/adr/0002-foundations.md) — foundations: provider logic stays in adapter crates
- [ADR 0120](../../docs/adr/0120-generalized-hierarchical-authority.md) — generalized hierarchical authority
