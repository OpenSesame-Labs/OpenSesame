# Source-owned transport lifetime

This suite connects the source ownership and lifetime decisions in
[`source_lifetime.rs`](../../../crates/transport-security/src/source_lifetime.rs)
to the SPIFFE source, its production sink, and the Host's transport admission.
The parent contract is [ADR 0227](../../../docs/adr/0227-spiffe-withdrawal-under-ambiguous-snapshots.md).
The reviewed base and exact source hashes are in [coverage.json](coverage.json).

| Requirement | Lean evidence | Real-code evidence |
|---|---|---|
| Claiming an available source slot quarantines the previous generation; a reserved or withdrawn source is unusable. | `claim_quarantines`, `reserved_is_not_usable`, `withdrawn_is_not_usable`, `quarantine_blocks_ordinary` | Vectors exercise the production generation manager. SPIFFE source tests start from a populated sink, including denial, a stalled RPC, and handle drop. |
| A stale owner or source epoch cannot activate, tighten, withdraw, or retire the current source. A retired owner cannot claim again. | `stale_owner_or_epoch_cannot_change`, `retired_owner_cannot_claim` | Manager vectors and source-ownership, handoff, and race regressions. |
| Tightening never increases a source deadline; use at equality is denied, and observed expiry remains latched through tightening, withdrawal, and ordinary activation. | `tightening_keeps_the_earlier_deadline`, `deadline_is_inclusive`, `observed_expiry_stays_unusable`, `latched_survives_nonactivation` | Vectors compare the actual manager decisions and latch. Separate clock tests cover a rollback after a bound is installed and sampling time after acquiring the activation lock. |
| Ordinary activation cannot change the source's identity or source-owned trust or reset its owner, epoch, and deadline. For a managed source, only an owned activation recovers withdrawn material. | `ordinary_cannot_reset_fence`, `only_activation_recovers` | Vectors exercise identity/trust refusal and generation results; separate manager and gateway regressions check trust collisions, removal, and unrelated updates. |
| A generation-bound signer releases a successful inner signature only if both checks see the expected usable generation. | `released_signature_has_live_matching_checks` | Eight Lean cases exercise the Rustls signer wrapper before expiry and across expiry, withdrawal, and rotation, including a deliberately delayed inner signer. |

The shared Lean checker verifies 13 independently recorded theorem signatures
and emits 33 finite cases: one claim, four owner/epoch cases, twelve deadline
cases, eight ordinary-activation cases, and eight signer cases. The correspondence
tests compare those cases with the Rust generation manager, its test-only latch
observation, and the Rustls signing wrapper. The runner also requires named source, clock, TLS, and gateway
regressions to execute and pass. See [negative controls](NEGATIVE-CONTROLS.md).
Run `npm run verify:source-lifetime-formal` with the pinned Lean and Rust
toolchains and repository dependencies installed.

These results prove properties of an abstract state machine and exercise a
finite correspondence matrix; they do not prove that all Rust executions refine
it. The model uses one nonnegative integer clock and a Boolean input for whether
trust is preserved. It does not prove the actual bundle comparator, tombstone
persistence, manager binding, u64 overflow behavior, certificate validation, or
concurrent scheduling. The lock projection is rooted at the SPIFFE source; it
does not cover gateway/storage-only dependency changes. Root workspace manifest
feature changes are not projected by this suite and require separate review.
Its `usable` predicate has no expected-generation input;
the signing model adds an explicit expected generation at both checks but does
not prove arbitrary Rust executions refine the model or that the underlying
signer itself is safe. It abstracts successful source activation as receiving a
valid candidate: a holder of the manager's owner capability is trusted to supply
fresh Workload API evidence. The model treats repeated withdrawals as a single
Boolean state and does not model a new generation for a changed withdrawal
reason. Runtime tests supply evidence for selected cases outside the model.

The runtime checks both wall time and a monotonic deadline after the source
observes an outage. The stale interval begins at observation, not at a physical
disconnect that an unscheduled source task has not detected. It assumes the
wall clock is correct when the certificate deadline is first converted;
`std::time::Instant` does not portably guarantee that it advances during suspend,
so rollback across suspend can extend real elapsed time. The runtime checks
the source generation immediately before and after the TLS signature and after
the handshake and at request admission. A check cannot cancel a key operation
already in progress; scheduling can allow the key operation to start after the
deadline, and the generation can change between the final check and network
output. A standalone `client_config` or `server_config` has no generation-bound
signer. Source-owned listener configs disable session resumption; earlier
ordinary configs may resume while current, and their session caches recheck the
generation before and after retrieval. TLS 1.2 and 1.3 controls cover both source
resumption refusal and a previously prepared connection after source claim. A source claim immediately after cache
retrieval can still race the resumed handshake; the server's post-handshake
check rejects that stale connection before application admission. These cache
operations are covered by runtime tests rather than the Lean model.
Already-admitted work cannot be rolled back. Source-owned
trust tombstones are in-memory and do not establish persistence across restart.

## Review log

2026-11-22 (#2680, session-revocation lineage): `crates/storage/Cargo.toml` adds the test-only `tempfile` dev-dependency. Its only effect on `Cargo.lock` is one dependency edge, which is why the lock projection was re-recorded; it was checked against main's lock. `crates/storage/src/lib.rs` declares `pub mod host_membership` (withdrawal-fence queries) and checks and applies each migration version inside one `BEGIN IMMEDIATE` transaction, so two Host replicas cannot both apply it. `crates/gateway/src/lib.rs` declares `native_authority` and `native_device`. Pending device codes moved from the in-process map to the Host store. The old `device_capacity_check_holds_the_map_lock` pact is replaced by `native_device::tests::device_capacity_check_holds_the_write_transaction`: the capacity count and insert in `native_device::create` stay inside one `BEGIN IMMEDIATE` transaction. `device_tests.rs` `authorize_capacity_fence_holds_under_interleaving` still exercises the fence. `transport/status_tests.rs` only drops an unused `Duration` import. No source-lifetime, signing-fence or trust-generation code changed. Only the reviewed blob evidence moved; the base revision is unchanged.

2026-11-23 (RustSec fix, branch claude/rustsec-url-chrono): url 2.5.8 -> 2.5.9 (RUSTSEC-2026-0592) and form_urlencoded 1.2.2 -> 1.2.3, reviewed as registry source diffs: url's blob: origin now takes the inner origin only for http, https and file (the stack-overflow fix), the path percent-encode set adds `^`, a backslash is no longer a host delimiter for non-special schemes, file-host drive-letter stripping and root double-dot handling follow the WHATWG URL Standard; form_urlencoded clamps an out-of-range start position instead of panicking; percent-encoding stays 2.3.2; the oauth2 removal (RUSTSEC-2026-0543) drops chrono, iana-time-zone and windows-* from Cargo.lock. connection-broker is outside the opensesame-spiffe-source closure, so the oauth2 removal does not touch it; its lock projection changes only by the url and form_urlencoded versions and the edges to them (368 nodes before and after, none added or removed). spiffe 0.19.0 uses url only to parse Workload API endpoint addresses (transport/endpoint.rs), not SPIFFE IDs, and no covered source calls url. No modeled source, transition, guard or persistence changed, so the model needs no change; the recorded hashes are recomputed for the reviewed bytes and the base revision is unchanged. Each previous hash was first confirmed to match the pre-change lock and manifests. Executed: cargo test -p opensesame-connection-broker --lib (572 passed), opensesame-gateway --lib (1257 passed, 10 ignored), opensesame-spiffe-source (104 passed, 3 ignored); cargo clippy --workspace --all-targets -D warnings and cargo fmt --check clean; osv-scanner reports no lockfile advisories. Lean suites not run here (no Lean toolchain).
