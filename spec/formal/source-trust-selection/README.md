# Host source selection and NATS trust rotation

A Host listener configured with a `SpiffeTrustDomain` accepts its selected
client trust bundle only from the current source-owned generation. A stored
bundle with the same profile cannot stand in for a source bundle that is
absent after a manager restart. The selected bundle must have the exact
profile label, `SpiffeTrustDomain` kind and configured domain. An ordinary file-backed listener
continues to use its configured generation trust.

`SourceTrustSelection.lean` proves seven obligations about this finite selector:
source-view freshness, presence, kind, profile and configured domain must all
hold, and every complete source input is accepted. The Rust correspondence
checks the 32 Boolean combinations against the actual selection function and,
for a fresh present view, compares all eight kind/profile/domain combinations
with its private production predicate. For a non-SPIFFE kind, safe bundle
constructors cannot attach a domain, so the full selection test uses the same
domainless bundle for both abstract domain bits. The harness supplies stale and
fabricated source views to exercise these branches; this is not a proof of the
manager or of Rust execution. A separate
selector regression checks the returned profile, kind, anchors, CRLs, and
generation against the requested entry in a two-domain source view;
this exact-return behavior is tested rather than proved by the Boolean model.
The separate runtime regression reconstructs the source manager with a stored
collision, checks the actual generation-bound source lookup, and exercises live
TLS with source and stored CAs. It reconstructs a manager over the same
in-memory store; it is not a full operating-system process restart or a real
Workload API test.

The manager's `source_trust(generation)` serializes its lookup with source
activation and rejects a changed generation. The existing TLS handshake and
request guard recheck that generation; operations already admitted are not
rolled back. The design assumes the configured source and the generation
manager's owner API are trusted to publish the source view. This suite does not
persist history or prove that a domain once served remains reserved after
restart. On its own it does not establish peer URI-domain matching, exclusive SPIFFE
selectors, full X.509-SVID validation, or behavior of arbitrary consumers that
read `Generation::trust` directly. Those require separate contracts.

Run `npm run verify:source-trust-selection-formal` after the suite is registered
and reviewed coverage hashes are recorded. The command pins Lean 4.24.0,
checks drift before invoking Cargo, requires exact nonzero test results, and
runs correspondence, the exact-return control and the live regression. Run
[negative controls](NEGATIVE-CONTROLS.md) separately to exercise selected
implementation and runner failures. The source-lifetime suite
must also run when its mapped files change.

Cargo configuration and proof-runner helpers are execution metadata, not
implementation paths that select this suite by themselves. The drift check
records reviewed configuration and helper bytes before Cargo runs. The
`.cargo/config.toml` entry is exactly that recorded metadata: a committed musl
cross-link configuration (linker and C compiler driver names resolved on
`PATH`, no machine-local paths) that decides how the pinned toolchain compiles
and links every reviewed source. The executed regression evidence on the pinned
bytes — the pinned Lean 4.24.0 selector model (39 theorems, no unapproved
axioms) re-emitting the complete 32-vector matrix, the correspondence test, the
exact two-bundle return control, and the live reconstructed-manager TLS
regression — was produced under this configuration and is recorded in the
exposure-matrix host-listeners review; editing the file invalidates that
evidence and fails the drift gate closed. These checks
assume trusted committed and checked-out execution metadata, the selected
toolchain, and already trusted external dependencies. A separate runner-integrity
guard is needed to enforce the execution-metadata assumption across pushes.

Run `python3 -I spec/formal/source-trust-selection/test_drift.py` for scratch
workspace-projection, build-script, and forged-bytecode controls. The suite
checks its reviewed source bytes and Cargo configuration before executing Cargo.

## NATS client trust and rotation

The separately registered `nats-trust-rotation` suite checks the NATS client
paths under [ADR 0132](../../../docs/adr/0132-optional-mtls-and-workload-identity.md).
Its implementation filter and Cargo dependency projection are independent of
the Host selector: a gateway-only edit does not start the NATS server tests.
The shared Lean file has 39 required theorems: the seven selector obligations
above and the following 32 NATS obligations. The latter are abstract models,
not a proof that Rust, Tokio, TLS or NATS refines them.
Selection is at mapped-file granularity: a test-only edit within a mapped
implementation file still selects its suite; separate test and proof files do
not select it by themselves. The four local package manifests are mapped as
whole files, so even a non-build edit to one selects the suite. Root
`Cargo.toml` and `Cargo.lock` changes use the reviewed task-bus dependency
and workspace projections; unrelated entries do not select it. Fixture and
runner files are reviewed verification inputs, not implementation triggers.

| ID | Requirement and implementation | Lean obligation and evidence |
|---|---|---|
| NATS-T1 | [`load_material`](../../../crates/task-bus/src/nats_connect.rs) accepts trust only for the configured profile and kind. A SPIFFE environment locator must also match its configured domain, and a PEM-file locator cannot be replaced by injected trust. | `wrong_kind_is_refused`, `wrong_profile_is_refused`, `wrong_domain_is_refused`, `selection_requires_all`, `file_locator_rejects_injection`, `mismatched_locator_is_refused`; 16 comparisons against the actual connection-options path exercise the eight kind/profile/domain rows for each policy source. |
| NATS-T2 | An injected client identity is refused if the policy names no identity or identifies a PEM-file source; a configured source kind must match its public reference. An identity referenced as SPIFFE must pass the client SVID profile; a SPIFFE locator also requires its exact configured canonical ID. | `unrequested_identity_is_refused`, `file_locator_rejects_injection`, `mismatched_locator_is_refused`, `wrong_client_id_is_refused`, `malformed_client_svid_is_refused`, `client_svid_requires_both`; four Lean-emitted ID/profile rows are compared with actual connection options, and runtime tests check normal PEM loading, managed injection and stored SPIFFE identities. The two Boolean SVID facts model independent checks; the model does not prove the certificate parser or Rust implementation correct. |
| NATS-C1 | A CRL loaded at session construction constrains handshakes using that captured TLS configuration; unreadable, empty or malformed configured files fail closed. An injected bundle's CRL is retained when there is no configured CRL. | `configured_and_injected_crls_are_refused`, `empty_configured_crl_is_refused`, `multiple_crls_are_refused`; a live server test checks an actually revoked server certificate and an unrevoked control. |
| NATS-D1 | Server expectations, CRLs, provisioning credentials and explicit TLS minimums in environment configuration require TLS; malformed TLS flags and partial or contradictory identity, trust or credential sources are refused. A retry limit without a transport policy is refused; an environment-selected plaintext override requires an explicit false TLS flag. Stored plaintext policies with trust, a server expectation, or a nondefault minimum are refused. | `environment_other_requires_tls`, `environment_trust_requires_tls`, `environment_server_requires_tls`, `environment_crl_requires_tls`, `environment_minimum_requires_tls`, `retry_without_policy_is_refused`, `nonassertive_plaintext_is_refused`, `invalid_security_flag_is_refused`, `unrequested_identity_is_refused`, `conflicting_sources_are_refused`, `plaintext_trust_is_refused`, `plaintext_server_is_refused`, `plaintext_nondefault_minimum_is_refused`; runtime configuration tests cover the flag spellings and representative settings. |
| NATS-R1 | A failed rotation keeps the accepted session, material and view; a successful explicit update is the material reused by a later implicit update. | `failed_rotation_keeps_state`, `explicit_material_is_committed`, `implicit_material_is_retained`, `successful_rotation_publishes_session_and_view`, `implicit_after_explicit_reuses_material`; the live test checks the accepted session and both injected identity and trust. |
| NATS-R2 | A later serialized successful rotation controls the view and cannot be overwritten by an older opening attempt. | `later_serialized_success_controls_view` assumes ordered transitions. A controlled live overlap test exercises the actual rotation mutex; it is not a proof of scheduling or concurrency refinement. |
| NATS-R3 | A TLS config built with injected trust or identity admits only its first server-certificate verification attempt; resumption and early data are disabled. | `fresh_handshake_gate_admits`, `spent_handshake_gate_refuses`, `consumed_handshake_gate_refuses`; two Lean-emitted rows are compared with real NATS client handshakes. A TLS 1.2/1.3 mTLS proxy terminates TLS and forwards traffic to a pinned NATS server, and a separate test connects directly to its TLS 1.3 listener. Unit controls cover failed and concurrent verification attempts. The model is a sequential gate abstraction, not a proof of Rust atomics, TLS, SDK behavior, or source freshness. |
| NATS-R4 | An injected session uses an async-nats limit of one server selection per initial connection or reconnect cycle; ordinary sessions retain the configured value. A pending old-session drain cannot indefinitely hold the rotation caller. | `injected_reconnect_is_capped`, `ordinary_reconnect_limit_is_preserved`; eight Lean-emitted limit rows are compared with the Rust selector. The live test requests an unlimited limit, observes the capped client's terminal event, and rotates. A deliberately full Tokio channel exercises the drain timeout. The model does not prove DNS, timer scheduling, task shutdown or async-nats command-queue behavior. |

The correspondence substitutes `fresh = present = true` in the selector model:
NATS injection does not assert that a bundle came from a fresh SPIFFE source.
For an environment policy the configured locator's domain is compared to the
bundle even if the expected SPIFFE ID matches the injected domain. A stored
public policy contains no private locator: its domain check binds the bundle to
the expected SPIFFE ID, not to an absent configured locator. A non-SPIFFE
bundle cannot carry a SPIFFE domain; an independent DNS-policy regression
checks the kind comparison without relying on that restriction.
The separate `client-svid` vector mode exercises every combination of exact-ID
match and profile validity against an injected certificate. Its parser refuses
missing, duplicate or malformed rows. This finite matrix samples the profile
with dual-purpose versus client-only EKUs; it is not a proof of all X.509
inputs or of the parser.
Stored policies without locators and externally supplied managed or SPIFFE
material rely on the injecting caller to select the intended keys and anchors;
the client cannot infer their source provenance from certificate contents.
For a SPIFFE client locator, the leaf profile and exact ID are checked when the
session is constructed. This does not prove which source supplied the key or
bind that key to a source generation. A stored identity reference has no
private SPIFFE-ID locator to compare; the caller must select the intended ID.
For the profile model, that missing comparison is represented by substituting
`matchingId = true`; the profile requirement still applies.
The local SVID profile check does not build a certificate chain; client-chain
verification is the remote NATS server's responsibility when it requests and
verifies client authentication.
To rotate from injected material to PEM files, pass an explicit injection with
the corresponding fields cleared. Omitting the injection retains the previous
material and is refused when it conflicts with a PEM locator.

The pinned `webpki` verifier checks the first authoritative CRL. To avoid
silently ignoring another list, NATS refuses more than one supplied CRL and
refuses a configured file combined with a pre-injected CRL. This can deny a
deployment that needs multiple CRLs, including some intermediate-CA chains.
Configured CRL files accept only complete `X509 CRL` PEM blocks with whitespace
outside them; this refuses a truncated block that a later PEM marker could
otherwise conceal.
The stored `NatsTransport` type also represents an omitted minimum and an
explicit default TLS 1.3 minimum identically; presence cannot be recovered
after deserialization. Environment minimum presence is checked separately.
The gateway propagates an invalid environment-policy result before reading
the stored policy. The nonassertive-setting tests exercise the resolver itself;
the model does not prove gateway error propagation or environment isolation.
The NATS client's automatic reconnects reuse the TLS configuration captured
when its session opened. When either trust or identity is injected, that config
allows only one certificate-verification attempt across clones, including a
failed first attempt; resumption and early data are disabled. A disconnect or
failure after the attempt therefore needs explicit rotation or recreation,
and async-nats is capped at one server selection per initial connection or
reconnect cycle for injected sessions. A selection may try multiple resolved
addresses. That cap limits initial multi-server failover and may shorten a
larger requested limit. Ordinary sessions forward their configured limit;
async-nats interprets `0` as unlimited. DNS resolution precedes the SDK's
per-address timeout, so the cap does not impose a hard termination deadline on
a stalled resolver or its background task. The test compares the two Lean
rows to actual handshakes and requires an ordinary
file-backed control to resume on the same TLS 1.2/1.3 proxy. The proxy performs
client-certificate authentication and forwards NATS protocol traffic to the
real server; direct TLS 1.3 NATS coverage is separate. This is finite runtime
evidence, not a proof of TLS or concurrency refinement.

File-backed sessions still reconnect with their captured trust, identity and
CRL. Editing a file or withdrawing source material does not update an open
connection. A failed rotation keeps the old session; an implicit rotation can
explicitly reuse previously accepted injected material, whose freshness and
provenance remain the trusted caller's responsibility. The fence does not
cancel an in-flight first handshake or terminate an established connection.
After publishing a replacement session, rotation attempts to enqueue the old
drain command with a two-second timeout, subject to scheduling. Neither a
successful enqueue nor a timeout proves that the old connection or background
task has closed; a stalled resolver or other client clones can prolong it.
Dynamic source checks and source-generation signing fences for this standalone
client remain outstanding integration boundaries.

The rotation mutex orders attempts by lock acquisition, not by wall-clock
invocation. The session, immutable material and transport view are published
without an intervening await while the session write lock is held. Existing
operations finish before that swap; after a successful rotation, a concurrent
later rotation may supersede it. Cancellation before the swap leaves the old
state, while cancellation after it does not roll back the accepted state and
can interrupt draining the old connection. A synchronous view or health read
can observe the preceding snapshot during a commit and is not an atomic joint
snapshot with a separate read. The stable health handle switches to the new
connection's events; event timing and eventual health are runtime properties.

Install the pinned NATS fixture **before** running the suite:

```sh
bash scripts/mtls/mtls-fixtures.sh fetch nats-server
npm run verify:nats-trust-formal
python3 -I spec/formal/source-trust-selection/negative-controls.py --nats
```

The verifier only checks the existing archive and binary hashes and reads the
verified path; it never downloads a fixture. An absent or invalid cache fails
with the setup command. `OPENSESAME_MTLS_FIXTURE_DIR` selects a shared fixture
cache. Source hashes, fixture inputs, build-script absence and the task-bus
Cargo dependency and workspace projections are checked before Cargo runs.
The drift checker also fixes the names and `src/lib.rs` roots of the four
local Cargo libraries and independently lists the fifteen exact task-bus
`--lib` tests and one transport-security unit test
the runner must invoke; a manifest redirect is refused even if its coverage
hash is refreshed. The inventory checks names and ignored flags, not shell
control flow; the reviewed runner and its test-result checks remain trusted.
The named test files and their test-only support files are reviewed inputs,
not implementation triggers.

These checks do not parse Rust module or `include!` wiring. A reviewed source
change that introduces another source file must add it to the relevant
implementation mapping before later changes to that file can select this
proof. Until the shared wiring control is in place, reviewers must inspect
that closure; refreshing a coverage hash alone does not establish it.

## Review log

2026-11-22 (#2680, session-revocation lineage): `crates/storage/Cargo.toml` adds the test-only `tempfile` dev-dependency. Its only effect on `Cargo.lock` is one dependency edge, which is why the lock projection was re-recorded; it was checked against main's lock. `crates/storage/src/lib.rs` declares `pub mod host_membership` (withdrawal-fence queries) and checks and applies each migration version inside one `BEGIN IMMEDIATE` transaction, so two Host replicas cannot both apply it. `crates/gateway/src/lib.rs` declares `native_authority` and `native_device`. Pending device codes moved from the in-process map to the Host store. The old `device_capacity_check_holds_the_map_lock` pact is replaced by `native_device::tests::device_capacity_check_holds_the_write_transaction`: the capacity count and insert in `native_device::create` stay inside one `BEGIN IMMEDIATE` transaction. `device_tests.rs` `authorize_capacity_fence_holds_under_interleaving` still exercises the fence. `app_state.rs` removes the in-memory device-code, approval-failure and session-lifecycle maps (now durable Host tables), adds `client_app_url`, and binds the native authority configuration at startup. Source-trust selection and its admission paths are unchanged.
