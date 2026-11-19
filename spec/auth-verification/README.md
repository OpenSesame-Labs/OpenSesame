# Authentication decision contracts

This directory contains machine-checked Lean proofs for three **abstract**
decisions used by the Identity and client planes. They are the beginning of an
authentication verification effort, not a proof that OpenSesame implements an
authentication standard in full.

| Decision | Production entry point | Proven model properties | Implementation comparison |
| --- | --- | --- | --- |
| Ambient-cookie origin | `packages/control-plane/src/middleware/auth.ts`: `cookieAuthAllowed` | An unsafe request is admitted only with a listed or service origin; missing and untrusted origins are denied. Safe methods do not need an origin. | All 16 Boolean combinations, plus generated origins and methods. |
| Provisional session | `packages/control-plane/src/middleware/auth.ts`: `resolveProvisionalSession` | A successful decision requires an access-token prefix, mapping, present unrevoked unexpired session, and active or provisional principal. Expired, revoked, and suspended cases are rejected. | All 240 combinations of the finite predicates and three expiry positions, plus generated valid clocks. |
| Configured native OIDC response | `packages/app-core/src/browser/oidc/transaction.ts`: `prepareConfiguredOidc().complete` | An exchange can begin only once, with the original state, a live transaction and owner, no error, and a nonempty bounded code. Every attempted completion consumes the transaction. | All 128 Boolean combinations, generated invalid responses, the expiry boundary, and simultaneous completion attempts. |

`AuthAdmission.lean` has twelve named theorems. `verify.mjs` requires Lean
4.24.0, treats warnings as errors, verifies the theorem types against
`Audit.lean`, and checks the axioms of every named theorem against the reviewed
standard Lean axioms `propext` and `Quot.sound`. It also
evaluates `DecisionVectors.lean` from the same definitions and checks its
results against `decision-vectors.json`. The TypeScript tests use those vectors
to compare the actual functions to the executable model. This finite comparison
is testing, **not a proof of the TypeScript implementation or its runtime**.
`#eval` uses Lean's evaluator; the logical theorems are independently checked
by Lean's kernel.

The cookie abstraction classifies GET, HEAD, and OPTIONS as safe after the
implementation's case conversion and rejects a missing or empty header,
and takes the public URL's parsed origin as an input. It does not verify URL
parsing, CORS configuration, or the security of a configured origin. The session
abstraction assumes valid nonnegative clock and expiry dates, principal states
within the domain enum, an honest mapping of tokens to session records, and a
consistent observation of store contents. It does not prove that stored records
are validated at runtime or describe malformed principal states.
The actual resolver performs asynchronous reads; this model does not establish
atomic revocation or rule out changes between reads. The OIDC model abstracts
the original owner check and JavaScript's code-length check as Boolean inputs.
It proves only whether a token exchange may **begin**, not that an exchange or
sign-in succeeds.

These proofs do not establish OAuth or OIDC standards conformance, ID-token
signature and claims validation, PKCE security, browser and transport behavior,
third-party library correctness, side-channel resistance, or correctness of
all authentication code. They also do not formally relate Lean evaluation to
JavaScript execution; the conformance tests are a separate, bounded bridge.
Treating a different proof, a new input partition, or changes to the mapping as
covered requires explicit review and new tests.

`LegacyPkcePending.tla` separately models the legacy explicit-sign-in pending
slot across local and session storage. TLC checks matching, consumption,
conflicting lanes, expiry, corruption, and logout using two abstract state
values and atomic storage actions. The generated test in
`packages/app-core/src/lib/federation-pending.property.test.ts` exercises the
actual slot with in-memory storage and a controlled monotonic clock. Neither
the finite model nor the test proves browser concurrency, randomness, PKCE,
token verification, or standards conformance. The shared
[`verify:behavior-models`](../ui-behavior/README.md) command runs this model.

`AuthorizationRequest.tla` models the domain request's terminal transitions,
deadline, decision provenance, immutable bindings and version increments.
`packages/os-domain/src/__tests__/authorization-request-finite.test.ts`
exhaustively exercises finite cases of the actual machine. The model assumes
valid dates, clean initial decision metadata and no external mutation. It does
not establish the decider's authority, executor digest comparison or
persistence concurrency, and the tests do not prove TypeScript refinement.

## Run locally

Install the pinned toolchain using the standard Lean tooling, or use the
official [Lean 4.24.0 release](https://github.com/leanprover/lean4/releases/tag/v4.24.0).
The published SHA-256 for `lean-4.24.0-linux.tar.zst` is
`b14f5e5159219dd1a1956c3b806813319f5e94ccd5bdfd56f54520609a5bb5ec`.

```sh
LEAN_BIN=/path/to/lean node spec/auth-verification/verify.mjs
LEAN_BIN=/path/to/lean node --test spec/auth-verification/verify.test.mjs
npm exec -w @opensesame/control-plane -- vitest run src/__tests__/auth-admission.properties.test.ts
npm exec -w @opensesame/app-core -- vitest run src/browser/oidc/transaction.auth-proof.properties.test.ts
```

`LEAN_BIN` may be omitted when `lean` is on PATH; the runner starts it from
this directory so that `lean-toolchain` is honored by elan. The audit tests
deliberately introduce `sorry`, an unreviewed axiom, a missing or weakened
theorem, a replay flaw, and stale decision vectors in temporary copies, and
require every one to fail.

When intentionally changing a model, review the proof, assumptions, generated
vectors, and production comparison together. The evaluated bit strings can be
inspected with:

```sh
cat spec/auth-verification/AuthAdmission.lean spec/auth-verification/DecisionVectors.lean | lean -E warning --stdin
```
