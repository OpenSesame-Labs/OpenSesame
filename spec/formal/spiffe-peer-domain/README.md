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

2026-11-23 (RustSec fix, branch claude/rustsec-url-chrono): crates/connection-broker/Cargo.toml only drops `oauth2 = { workspace = true }` (the root workspace pin goes too); oauth2 was used solely for random PKCE verifier and OAuth state generation, now 32 OS-CSPRNG bytes base64url-encoded in flow::pkce. Removing it takes oauth2 5.0.0, chrono 0.4.45 (RUSTSEC-2026-0543, unmaintained), iana-time-zone 0.1.65, iana-time-zone-haiku 0.1.2, android_system_properties 0.1.6 and windows-core/-implement/-interface/-result/-strings out of Cargo.lock; url 2.5.8 -> 2.5.9 (RUSTSEC-2026-0592) and form_urlencoded 1.2.2 -> 1.2.3, reviewed as registry source diffs: url's blob: origin now takes the inner origin only for http, https and file (the stack-overflow fix), the path percent-encode set adds `^`, a backslash is no longer a host delimiter for non-special schemes, file-host drive-letter stripping and root double-dot handling follow the WHATWG URL Standard; form_urlencoded clamps an out-of-range start position instead of panicking; percent-encoding stays 2.3.2. The opensesame-gateway lock projection loses exactly those 12 packages and gains url 2.5.9 and form_urlencoded 1.2.3 (693 -> 683 nodes); every other change only retargets an existing edge to the new url or form_urlencoded. The gateway workspace projection changes only by removing workspace.dependencies.oauth2. No modeled source, transition, guard or persistence changed, so the model needs no change; the recorded hashes are recomputed for the reviewed bytes and the base revision is unchanged. Each previous hash was first confirmed to match the pre-change lock and manifests. Executed: cargo test -p opensesame-connection-broker --lib (572 passed), opensesame-gateway --lib (1257 passed, 10 ignored), opensesame-spiffe-source (104 passed, 3 ignored); cargo clippy --workspace --all-targets -D warnings and cargo fmt --check clean; osv-scanner reports no lockfile advisories. Lean suites not run here (no Lean toolchain).
