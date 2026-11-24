# DPoP replay-cache proof

This slice covers one property of the in-process DPoP replay cache. It does not
prove RFC 9449 compliance or the whole DPoP validator.

## Requirement and code

**DPOP-R1:** For one `InMemoryReplayCache`, a valid identifier successfully recorded for a
proof must be rejected as a duplicate through that proof's last acceptable
second. An unrelated request must not evict the identifier while it is still
within that window. At capacity, a fresh identifier must be refused instead of
evicting a remembered one. Empty identifiers and identifiers longer than 256
UTF-8 bytes are refused.

The implementation is [`InMemoryReplayCache::check_and_record_until`](../../../crates/proof/src/replay.rs).
[`DpopValidator::validate`](../../../crates/proof/src/validator.rs) supplies the
proof's `iat.saturating_add(max_age_secs)` as `valid_until`, after
[`decode_dpop_proof`](../../../crates/proof/src/jwk.rs) checks the proof's age.
The reviewed revision and source hashes are in [coverage.json](coverage.json).
See [ADR 0023](../../../docs/adr/0023-mcp-bearer-vs-dpop.md) and the existing
[replay-cache audit](../../../docs/security/audits/2026-08-08-security-audit-compendium.md#original-report-2026-08-08-dpop-replay-cachemd).

**DPOP-R2** (2026-11-24): every instant at which the decoder's age check
would still admit a proof lies at or before the deadline the validator gives
the cache for that proof's identifier, so a replayed proof is refused for its
whole acceptance window. `decode_dpop_proof` refuses a proof that
[`proof_age_admits`](../../../crates/proof/src/replay.rs) rejects (`now - iat`
must not overflow and must be at most `max_age`), and `DpopValidator::validate`
passes [`proof_replay_until`](../../../crates/proof/src/replay.rs)
(`iat.saturating_add(max_age)`) as `valid_until`.

## Formal properties

[ReplayPolicy.lean](ReplayPolicy.lean) proves:

- `accepted_first_remembers`: an accepted first insertion retains its
  identifier through at least `validUntil`, including saturating arithmetic.
- `live_entry_survives_any_bounded_prunes`: any finite sequence of pruning
  times at or before that valid-until instant preserves the entry.
- `accepted_then_no_replay_during_window`: after an accepted insertion and
  such intervening prunes, a same-identifier request at or before the valid-until
  instant is rejected as replay. This includes the exact expiry boundary.
- `fresh_proof_inside_replay_window` (DPOP-R2): for any `now` within `i64`,
  `ageAdmits now iat maxAge` implies `now ≤ replayUntil iat maxAge`, including
  overflowing subtraction and saturating addition.
- `fresh_replay_refused` (DPOP-R2): composing that with
  `accepted_then_no_replay_during_window`, a replayed proof (same `jti` and
  `iat`) that the age check would still admit is refused after the first
  acceptance and any bounded prunes.
- `full_cache_never_accepts_new`, `empty_identifier_denied`, and
  `long_identifier_denied`: a full cache and invalid identifier inputs fail
  closed in the model.

The model assumes each `check_and_record_until` call is one atomic transition,
matching the current mutex-protected implementation. Its replay claim assumes
that no intervening request prunes the entry at a time after `validUntil` and
then the clock moves backward into the old proof window. It does not prove a
monotonic clock, distributed consensus, persistence across restart, or safety
between cache instances. A model of an integer time and a finite test do not
establish those properties of a deployment.

## Reproduce

Install Lean 4.24.0 from [lean-toolchain](lean-toolchain) and the Rust version in
[`rust-toolchain.toml`](../../../rust-toolchain.toml), then run from the repo:

```sh
bash spec/formal/dpop/verify.sh --negative-controls
```

`OPENSESAME_LEAN_BIN` and `OPENSESAME_RUSTC` may point to existing binaries.
The command rejects the wrong toolchain versions and treats Lean warnings,
including `sorry`, as errors. Lean produces 9,216 distinct replay inputs and
720 DPOP-R2 window inputs (12 instants from `i64::MIN` to `i64::MAX` for
`now` and `iat`, five maximum ages including -1 and `i64::MAX`); the harness
compares `proof_age_admits` and `proof_replay_until` with the model on each and
checks the containment. The Rust
harness includes the actual `replay.rs` source and compares two real calls per
input, with and without a previously retained different key. It checks empty,
ASCII and multi-byte identifier boundaries; TTL and proof-window boundaries;
zero and nonzero capacity; and `i64` saturating arithmetic. It then runs 40
races with eight threads per race, requiring exactly one acceptance each time.
These races exercise scheduling but do not exhaust all possible interleavings.
The existing `shuttle_replay` test also passed with 100 randomized scheduler
iterations in this workspace. To rerun it with Cargo dependencies installed:

```sh
SHUTTLE_ITERATIONS=100 cargo test --locked -p opensesame-proof \
  --features concurrency-test --test shuttle_replay
```

This samples schedules; it does not establish an exhaustive concurrency proof.

The test provides minimal `ProofError`, clock and future-skew definitions so
that the real replay module can compile directly without compiling the full
workspace. It exclusively calls the explicit-clock method; the stubbed wall
clock panics if called. The harness does not test the actual JWT validation,
cryptography, key binding, URI/method checks or `jti` distribution. That
`decode_dpop_proof` refuses what `proof_age_admits` rejects and that
`validate` passes `proof_replay_until` to the cache rests on review of
`jwk.rs` and `validator.rs` (both hashed in coverage.json), not on an
executed call. DPOP-R2 also assumes a replayed proof carries the same `iat`;
a new proof needs the holder's key. A passing finite correspondence matrix is not a proof
that all Rust executions refine the model. The implementation's `ReplayCache`
trait also permits other cache implementations; those are outside this proof.

The optional negative-control phase copies the real source to temporary files,
introduces eight independent defects, and requires each to fail a correspondence
assertion: an exclusive expiry boundary, a lost proof window, a missing
identifier check, capacity overflow, an accepted empty identifier, an
accepted oversized identifier, an exclusive age boundary and a replay deadline
one second short. It never changes the checked-in source. The
final hash check fails if the replay module, validator, or proof decoder changed
since review. Hash equality is a drift signal, not evidence that review or
implementation correspondence is complete.
