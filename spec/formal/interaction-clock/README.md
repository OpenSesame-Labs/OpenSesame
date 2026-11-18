# Interaction deadline admission

CLOCK-1: at an application clock sample, an interaction is live only when
both dates are valid and the sample precedes its expiry. Final approval also
requires the activation to be live at that sample. Equality is expired. An
expired interaction must not be approved or consumed at that sample.

The model is [InteractionClock.lean](InteractionClock.lean). Its seven required
theorem types are in [required-theorems.lean](required-theorems.lean). The
model treats a valid JavaScript date as an integral millisecond timestamp and
an invalid date as an invalid flag. It proves the predicate for all modeled
integers; 36 Lean-generated representative vectors compare that predicate to
the actual TypeScript helper. The actual HTTP route tests pause an activation
lookup or an interaction lookup at the deadline, check that those requests are
refused, and verify live controls. They also exercise expiry after an activation
has been spent and after an accepted proof attempt has been recorded.

The checks sample the application clock after activation lookup, after proof
recording before the decision, and inside the consume transaction callback.
They do not prove clock monotonicity, a deadline at the database CAS or commit,
transaction isolation, storage rollback, or later host effects. A rejection
after proof recording can leave the activation spent and the attempt recorded;
it is not a rollback. Activation completion and subject-specific expirations
are separate boundaries. The [coverage manifest](coverage.json) identifies the
reviewed source bytes; hashes detect drift rather than proving refinement.

Run `npm run verify:interaction-clock-formal` with Lean 4.24.0 and the
repository's Node dependencies installed. Run
`python3 spec/formal/interaction-clock/negative-controls.py` to check that
isolated equality, inverted-deadline and unchecked-deadline mutations fail the
real correspondence, then that the normal command still passes. The pre-push
registry selects this suite when a mapped implementation changes.
