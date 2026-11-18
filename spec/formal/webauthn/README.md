# Formal interaction approval binding

This slice models the pure `approve` and sequential `consume` functions in
[`interaction.ts`](../../../packages/os-domain/src/machines/interaction.ts).
The security intent is in [ADR 0084](../../../docs/adr/0084-external-authorization-notifications.md)
and [ADR 0086](../../../docs/adr/0086-wallet-native-interaction-layer.md).
A proof bound to a different request must not approve this interaction. Without
that check, an approval for one operation could be applied to another.

The reviewed base revision and SHA-256 hashes are in
[`coverage.json`](coverage.json). The interaction machine's reviewed bytes
include a fix after that base revision, so the recorded source hash identifies
the reviewed bytes. Lean 4.24.0 checks the model in
[`ApprovalBinding.lean`](ApprovalBinding.lean); the conformance test calls the
actual TypeScript functions, not a copy. Its 6,144 generated inputs cover all
six declared interaction kinds, eight lifecycle states, valid and invalid
current clocks, four expiry classes (invalid, before, at, and after the clock),
four request-digest cases (absent, empty, and two different strings), and four
proof-digest cases. The model uses an integer when the clock is valid; the
implementation comparison samples finite milliseconds and invalid dates.

| ID | Requirement | Lean theorem | Implementation boundary |
|---|---|---|---|
| APR-B1 | If approval succeeds with a stored digest, the proof digest equals it. | `approved_proof_matches_request` | `approve` compares `boundDigest` to `requestDigest`. |
| APR-B2 | An operation kind cannot be approved with an absent or empty digest. | `operation_needs_digest`, `operation_denies_empty_digest`, `approved_operation_has_nonempty_digest` | `KINDS_REQUIRING_DIGEST` and `approve`. |
| APR-B3 | With no stored digest, an uncheckable non-empty proof digest is refused. | `absent_digest_rejects_nonempty_proof` | `approve`. |
| APR-B4 | Approval requires the awaiting-approval state, a readable current clock, and a readable future expiry. | `approval_requires_awaiting`, `approval_denied_at_or_after_expiry`, `invalid_expiry_denied`, `invalid_clock_denied`, `approved_requires_valid_clock`, `valid_clock_preserves_policy` | `approve`, `step`, `assertLive`, and `hasLapsed`. |
| APR-B5 | After a successful sequential consume, the consumed state cannot be consumed again. | `consumed_cannot_consume_again` | `consume` and the transition table. |

The previous implementation approved an operation with matching empty stored
and proof digests, and treated an invalid current clock as live. The reviewed implementation refuses that case, and an
explicit regression tests it. The hosted `ApproveInteractionSchema` separately
requires at least 16 characters, so the earlier domain behavior alone did not
establish an externally reachable attack. The theorem proves non-emptiness and
equality, not that a digest is syntactically or cryptographically valid.
Session-only interaction kinds continue to admit a digest-free approval.

## Run

Install the Lean version pinned in `spec/formal/auth/lean-toolchain`, and install
the repository's Node dependencies. Then run from the repository root:

```sh
bash spec/formal/webauthn/verify.sh
python3 spec/formal/webauthn/negative-controls.py
```

Set `OPENSESAME_LEAN_BIN` to the absolute Lean executable when it is not on
`PATH`. The check treats Lean warnings, including `sorry`, as errors. It emits
model cases, compares them to the real code, and refuses unreviewed source-hash
drift. The negative controls use temporary source copies, rerun the same
conformance test against eight broken variants, and verify the unmodified code
before and after. They cover omitted digest guards, including the empty-digest
guard, expiry boundary, unreadable expiry and current clock, an illegal
approval edge, and sequential double-consumption.
A scratch mutant is rejected as the implementation by the normal `verify.sh`.

After source changes, inspect the affected requirements and the code-to-model
correspondence before updating hashes. Advance `reviewed_revision` only after
reviewing the source at that commit. Hashes detect drift; they do not establish
correctness or substitute for a review.

## Limits

Lean proves the model, not that arbitrary TypeScript execution refines it. The
finite matrix is a correspondence test. `sealApprovalProof` is a compile-time
brand constructor; these checks assume a server-established proof and do not
verify a WebAuthn assertion, challenge, origin, relying-party ID, signature,
credential state, or assurance. They also do not prove SHA-256 collision
resistance, how the digest is constructed or recomputed by an executor, the
identity of the approver, the security of the hosted route, or concurrency and
atomicity of storage compare-and-set. The supplied clock can be stale by the time an awaited store operation or
transaction commits; these checks do not prove expiry at durable linearization.
The sequential consume property is not a proof against two concurrent writers. Keep the existing real WebAuthn, route,
executor, and concurrency checks in addition to this slice.
