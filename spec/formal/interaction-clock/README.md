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
