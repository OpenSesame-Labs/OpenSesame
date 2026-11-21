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

The shared Lean checker verifies 12 independently recorded theorem signatures
and emits 25 finite cases: one claim, four owner/epoch cases, twelve deadline
cases, and eight ordinary-activation cases. The correspondence test compares
those cases with the actual Rust generation manager and its test-only latch
observation. The runner also requires named source, clock, TLS, and gateway
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
feature changes are not projected by this suite and require separate review. Its `usable` predicate has no expected-generation input,
so post-handshake rejection of stale generations is supported by finite TLS tests,
not by this proof. It abstracts successful source activation as receiving a
valid candidate: a holder of the manager's owner capability is trusted to supply
fresh Workload API evidence. The model treats repeated withdrawals as a single
Boolean state and does not model a new generation for a changed withdrawal
reason. Runtime tests supply evidence for selected cases outside the model.

The runtime checks both wall time and a monotonic deadline after the source
observes an outage. The stale interval begins at observation, not at a physical
disconnect that an unscheduled source task has not detected. It assumes the
wall clock is correct when the certificate deadline is first converted;
`std::time::Instant` does not portably guarantee that it advances during suspend,
so rollback across suspend can extend real elapsed time. The current guarantee
checks the generation after a TLS handshake and at request admission; a
handshake started earlier may still present or use the old key before the
post-handshake check. Already-admitted work cannot be rolled back. Source-owned
trust tombstones are in-memory and do not establish persistence across restart.
