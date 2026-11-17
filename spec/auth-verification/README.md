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

The separate [source-derived proofs](source/README.md) translate the real
cookie decision, principal eligibility check, authorization transition graph,
OIDC completion callback, OIDC evidence custody, the WebAuthn assertion gate,
and four other transition graphs through a restricted TypeScript subset before
checking fifty-four further theorems. OIDC transaction preparation is outside the
translated subset. That
translation and its runtime assumptions remain part of the trusted boundary;
it is not a verified JavaScript semantics or a proof of complete protocols.

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

`ProvisionalSessionReads.tla` separately models one resolver attempt with
atomic snapshot reads and monotonic invalidation. TLC checks that an accepted
attempt observed an eligible token, session and principal, and that an attempt
already invalid when it starts cannot succeed under those assumptions. A
deliberately stronger current-revocation invariant has a counterexample:
revocation after the session read can occur before the request returns. The
controlled-store property test in
`packages/control-plane/src/__tests__/auth-session-interleaving.property.test.ts`
exercises generated token removal, session removal, expiry, revocation and
principal-suspension schedules in the real resolver. Separate reachability
checks require already-invalid attempts and revoked-session reads to reach a
denial, so the safety invariants cannot pass just because those paths are
unreachable. These tests do not establish atomic revocation or the consistency
of production storage.

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

`NativeOidcEvidence.tla` models custody of one already-issued evidence object
and a distinct unknown handle in one JavaScript agent. TLC checks one-use,
owner, expiry and deletion invariants, and eventual consumption under weak
fairness of a genuine consume attempt. Without that fairness assumption an
unused object may remain unconsumed indefinitely; a negative check confirms
this counterexample. Other negative controls require both success and denial
to be reachable and detect a model with deletion removed. The generated test
in `packages/app-core/src/browser/oidc/evidence-custody.property.test.ts`
uses genuine signed test tokens and checks the real custody functions across
owner and clock changes, forged handles, retries and reentrant owner checks.
The model assumes atomic consumption and monotonic retirement and expiry;
the test also exercises restoring the owner and clock. Neither verifies token
issuance, cryptography, browser behavior, local admission, or TypeScript
refinement.

`WebAuthnChallenge.tla` models two competing assertion attempts for one
challenge, including purpose and principal binding and the expiry boundary.
It checks one-use, rejection of registration purposes, and successful use only
of a challenge live when consumed. TLC explores one process with one issuance;
challenge uniqueness, immutable metadata, the signature result, and atomic
store consumption are assumptions. A signature check may finish after expiry
if consumption occurred earlier. Negative controls detect missing consumption
and admitting registration purposes. Generated cases exercise the real memory
store and assertion gate with a controlled clock and a mocked WebAuthn verifier;
they also test malformed and nonmatching challenges and concurrent callers.
WebAuthn's RP ID, origin, user-verification and signature requirements remain
separate obligations under the implemented WebAuthn profile.

`DeviceAuthorization.tla` models the domain session's approval, denial,
consumption, explicit or automatic expiry, and bounded polling. It checks
terminal states, deadline decisions, approval provenance, immutable digests,
rejected operations, and polling effects. Explicit expiry is permitted before
the deadline by the implementation; automatic expiry is not. Generated
sequences compare the real domain operations with an independent oracle at the
deadline and on either side. These artifacts do not model the RFC 8628 issuer,
polling-rate enforcement, authorization, durable persistence, or concurrent
grant issuance.

`AgentRegistration.tla` models one registration through claim, pre-claim TTL,
expiry and revocation with at most three successful version increments. It
checks immutable identity, terminal states, version changes, nonempty claimants,
ownership and the distinction between pre-claim expiry and revoking an already
claimed registration. Generated sequences exercise the real domain functions,
including retries, idempotent actions, empty claimant identifiers and deadlines.
The model does not authenticate the claimant or prove possession, token issuance,
external effects or durable-store concurrency.

`ClaimLifecycle.tla` models a fresh domain claim from presentation through
review and completion, denial, revocation or expiry with at most four version
advances. It checks immutable digests, terminal states, deadline handling,
review before completion or denial, and version changes. Generated sequences
exercise the domain operations. Explicit revocation and expiry can occur before
the deadline. The domain completion function rejects an empty claimant string;
neither it nor this model authenticates the actor. Token verification, manifest
contents, caller authority and persistence concurrency remain outside this model.

`SamlReplayCustody.tla` models a bounded in-memory set of issuer/assertion-ID
pairs, expiry, capacity, pruning and process restart. TLC checks retained replay
denial, expiry and capacity bounds, and preservation of another issuer's entry.
A negative check exhibits replay after restart. Generated sequences exercise
the actual local custody function; another test fills its 1,024-entry capacity
and checks the exact expiry boundary. These checks start after signature and
protocol validation and do not establish SAML conformance or durable,
cross-process replay protection.

`FederatedPendingIntegrity.tla` models modern and legacy hosted-federation
cookies under attacker-controlled payload changes. TLC checks that modern
acceptance binds the complete payload and that a legacy signature cannot add
organization or visitor authority. Generated tests mutate every authenticated
field in the real codec and cover cross-format downgrade. The model assumes
ideal HMACs with separate keys and an injective core encoding; the source proof
trusts Node's crypto, JSON, base64url, its checker and manual abstraction.

`IssuerTrustResolution.tla` models static, admitted-organization and active
visitor trust precedence while dynamic records change. Generated configurations
exercise the real resolver. It exposes that an ineligible organization may
fall through to an active visitor record and that a decision may outlive later
revocation; those are documented snapshot semantics, not instantaneous
revocation guarantees.

`FederatedTrustBinding.tla` composes the provenance retained at start with the
authority re-resolved at callback. TLC checks exact source and record binding,
single provenance, the OIDC leg kind, and the rule that legacy cookies can only
resume under static OIDC trust. Generated cases exercise the real predicate,
and source checks require the callback guard before client selection or
networking. These artifacts assume the pending cookie has already passed its
separate integrity check and do not prove issuer ownership, repository
atomicity, credentials, token exchange, claim validation or OIDC conformance.

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
LEAN_BIN=/path/to/lean npm run verify:auth-source
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
