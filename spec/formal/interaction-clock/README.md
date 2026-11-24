# Interaction deadline admission

CLOCK-1: at an application clock sample, an interaction is live only when
both dates are valid and the sample precedes its expiry. Final approval and
activation completion also require the activation to be live at that sample.
Equality is expired. An expired interaction must not be approved, consumed, or
activated at that sample.

The model is [InteractionClock.lean](InteractionClock.lean). Its eight required
theorem types are in [required-theorems.lean](required-theorems.lean). The
model treats a valid JavaScript date as an integral millisecond timestamp and
an invalid date as an invalid flag. It proves the predicates for all modeled
integers; 36 Lean-generated date vectors and 216 activation vectors compare
the predicates to the actual TypeScript helpers. HTTP route tests pause reads
and verification across deadlines and exercise live controls.

Approval checks sample after activation lookup and proof recording; consumption
samples inside the transaction callback. WebAuthn and TOTP completion sample
after activation lookup and immediately before the activation update. TOTP
also samples after secret lookup and after the account budget check before it
spends the one-time code.

These are application samples. They do not prove clock monotonicity, a deadline
at the database CAS or commit, transaction isolation, storage rollback, or
later host effects. WebAuthn verification may consume a challenge and advance
a credential counter before a late refusal. TOTP may consume its one-time code
or update attempt counters before a late refusal. An approval rejection after
proof recording can leave the activation spent and the attempt recorded.
Subject-specific expirations are a separate boundary. The
[coverage manifest](coverage.json) identifies reviewed source bytes; hashes
detect drift rather than proving refinement.

Run `npm run verify:interaction-clock-formal` with Lean 4.24.0 and the
repository's Node dependencies installed. Run
`python3 spec/formal/interaction-clock/negative-controls.py` to check that
isolated deadline and activation-pair mutations fail the real correspondence,
then that the normal command still passes. The pre-push registry selects this
suite when a mapped implementation changes.

## Transactional settlement samples

Consume settlement samples the application clock before the interaction CAS,
before reservation acquisition, after reservation acquisition, after outbox
dispatch, before reservation commit, and after the awaited fence commit before
the synchronous Host projection. An expired sample throws inside the unit of
work so staged database and outbox writes roll back.

`settlement_requires_every_stage_live` proves the abstract conjunction: a
settlement can be admitted only when every modeled sample is live. The
controlled-clock regression pauses reservation acquisition and demonstrates
that the former single-sample implementation returned 200 after expiry.

This does not prove database commit-time clock admission, monotonicity of the
application clock, or rollback of effects outside the unit of work. There is a
small unmodeled interval between the final application sample and the database
commit itself. The synchronous Host projection is also not transactionally
rolled back if a later database commit fails; that pre-existing boundary is
documented rather than represented as a Lean guarantee.

## Unit of work (2026-11-24)

`uowOutcome` models the consume transaction: the six application samples of
`consumeAndSettle`, each before the next staged write, and rollback when a
sample refuses. `uow_commit_requires_every_sample_live`,
`uow_refusal_persists_nothing` and `uow_crossing_at_any_sample_refuses` hold
for the model; `uow_crossing_after_last_sample_commits` states the remaining
window instead of hiding it: a deadline that passes after the last application
sample and before the database commit is committed. Eight Lean rows (the
deadline passing just before each sample, after the last one, or never) are
replayed against the real consume route by
`interaction-settlement-clock.security.test.ts`, which advances the
controlled clock just before the k-th sample inside the transaction and
checks the HTTP status, the stored interaction status, the committed
execution fences and the number of samples taken. `negative-controls.py`
drops the dispatch sample or makes the commit or effect sample unchecked; each
fails the replay.

The replay uses the in-memory repositories. Their unit of work rolls back the
interaction and fence commit, but a reservation acquisition is applied eagerly
and survives the rollback as an unfenced held lease; Postgres runs the
acquisition inside the transaction and discards it. The replay therefore checks
committed fences, not held leases, and Postgres transaction atomicity remains
an assumption. Database commit-time admission and clock monotonicity remain
unproved.

