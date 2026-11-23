# SPIFFE peer domain and identity policy

A peer verified under a SPIFFE trust-domain bundle must chain to that bundle,
carry one canonical X.509-SVID in the bundle's explicit trust domain, and match
an exact SPIFFE ID service binding. DNS, non-SPIFFE URI and leaf-thumbprint
selectors cannot authorize a SPIFFE peer. The separately authenticated leaf
thumbprint still participates in revocation of the peer being bound. On a
forwarded request that bound peer is the ingress, not the originating client;
the originating client's CRLs and the ingress layer's deny hook are separate
controls. A forwarded assertion retains the already sealed ingress identity
policy.

`SpiffePeerDomain.lean` proves twelve independently pinned obligations about
abstract Boolean chain, domain and profile results, selector categories,
revocation, and a pure forwarding operation. Its 16 emitted selector vectors
are compared with real Rust `ServiceCaller` admission on sealed SPIFFE peers.
The actual TLS regression exercises real certificates, rustls verification and
peer attestation; separate tests cover a profile label distinct from its domain,
source-owned domain relabeling, outbound references, forwarded evidence, and
the existing forwarded-origin deny-hook regression. A live listener test also
passes sealed TLS evidence to `ServiceCaller::admit` and exercises exact-ID
bindings, separate leaf revocation, a thumbprint-only binding, and a wrong-domain
SVID with an otherwise matching binding. This composition is runtime evidence,
not a Lean proof of Rust refinement.
Both client-authenticating policies disable server session storage, TLS 1.3
tickets, and early data. A live rotation regression checks full handshakes,
old-connection denial, and new-domain recovery for TLS 1.2 and 1.3 under
both policies, for ordinary and source-owned generations. These are runtime
checks of the configured listener, not a formal proof of rustls session
semantics or a guarantee for standalone outbound client configurations.
The source-trust-selection suite separately models and tests the requirement
that a Host listener's selected source bundle names its configured domain.
The [negative controls](NEGATIVE-CONTROLS.md) exercise selected failures of
these boundaries and of the correspondence runner.

These theorems do not prove certificate parsing, cryptographic path validation,
all X.509-SVID requirements, the public attestation API's trusted-caller
assumption, Rust execution, or concurrency. The `verified` predicate takes
chain and SVID decisions as Boolean inputs; the vector correspondence covers
only the service-binding portion. The forwarding theorem is an abstract
identity function, with the production preservation path exercised separately
by tests. The durable history of source domains remains a different problem.

Run `python3 -I spec/formal/spiffe-peer-domain/test_drift.py` for scratch
workspace-projection, build-script, and forged-bytecode controls. The suite
checks its reviewed source bytes and Cargo configuration before executing Cargo.
The push hook assumes trusted execution metadata until its separate
runner-integrity guard is installed.

The runner uses the shared [Cargo freshness and scratch isolation
checks](../../../docs/security/formal-auth-verification.md) to prevent reuse of
another worktree's local artifacts under the documented toolchain and
concurrent-write assumptions. Source drift checks alone do not detect stale
compiled artifacts.

## Review log

2026-11-22 (#2680, session-revocation lineage): `crates/storage/Cargo.toml` adds the test-only `tempfile` dev-dependency. Its only effect on `Cargo.lock` is one dependency edge, which is why the lock projection was re-recorded; it was checked against main's lock. `crates/storage/src/lib.rs` declares `pub mod host_membership` (withdrawal-fence queries) and checks and applies each migration version inside one `BEGIN IMMEDIATE` transaction, so two Host replicas cannot both apply it. `crates/gateway/src/lib.rs` declares `native_authority` and `native_device`. Pending device codes moved from the in-process map to the Host store. The old `device_capacity_check_holds_the_map_lock` pact is replaced by `native_device::tests::device_capacity_check_holds_the_write_transaction`: the capacity count and insert in `native_device::create` stay inside one `BEGIN IMMEDIATE` transaction. `device_tests.rs` `authorize_capacity_fence_holds_under_interleaving` still exercises the fence. `app_state.rs` changes as recorded for source-trust selection. No SPIFFE peer-domain, service-binding or forwarding code changed.

2026-11-23 (#2680, merge of main 7ab65ea1 / #2898): `crates/gateway/src/app_state.rs` is the branch's reviewed bytes plus only main's two-argument `load_wasm_connectors` call. `Cargo.lock` is the union of both sides' edges (main's audit `hex`/`hkdf`/`hmac` and broker `sqlx` dev edges, the branch's storage `tempfile` dev edge; no new package or version), so the lock projection was recomputed for the merged graph.
