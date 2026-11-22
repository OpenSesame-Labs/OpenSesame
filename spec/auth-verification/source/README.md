# Proofs derived from authentication source

`npm run verify:auth-source` reads the current TypeScript source for
`cookieAuthAllowed`, `principalStillAuthenticates`, `canTransition`, the
callback of `prepareConfiguredOidc`, the custody function
`consumeNativeOidcProof`, the WebAuthn assertion gate, passkey custody, issuer trust,
federation pending-cookie integrity, federation trust binding, claim completion, SAML
replay custody, and
four additional domain transition graphs. It translates or structurally checks a small
supported subset before deriving Lean definitions, and asks Lean to check them against
independently stated policies in `Contracts.lean`. The generated definitions
are not checked in: every run derives them again from the files under review.
The runner checks the theorem types and audits the axioms of fifty-four named
theorems. Its negative tests change production source in memory, weaken a
proof, and require rejection.

The cookie proof covers the decision after mapping its inputs to four facts:
the method is one of GET, HEAD or OPTIONS after `toUpperCase`; the Origin is
a nonempty string; the allowlist includes that exact string; and parsing the
public URL either fails or yields an origin that does or does not match. The
proof establishes that the translated decision accepts exactly a safe method
or a nonempty origin that is listed or matches the parsed service origin.

The principal proof covers the completed repository lookup and the two state
comparisons in `principalStillAuthenticates`. It proves that the translated
check accepts exactly when the result is neither null nor undefined and its
state is neither suspended nor closed. The implementation does not itself
reject an unexpected state outside the domain enum; the database constraint
and typed repository are separate assumptions, not consequences of this proof.
The translation models short-circuiting and a null or undefined property read,
and Lean also checks that the translated decision does not perform such a read.
It does not model an exception from the repository or a hostile property getter.

The transition proof covers the real `canTransition` function and its private
literal table over the five declared request statuses. It proves that pending
can transition to each other status and that no terminal status has an outgoing
edge. It does **not** prove the rest of `settle`, withdrawal, expiry, authority,
the executor's digest check, or concurrent persistence.

The OIDC proof covers the completion callback after transaction preparation.
It checks the response predicate, single-use ordering before the first
external call, and the arguments passed to the exchange and proof verifier.
Its facts abstract whether the owner check succeeds, whether the transaction
is expired, whether the response state matches `pair.state`, and whether the
code is missing, empty, bounded, or oversized. Lean proves that exchange is
admitted exactly for an unspent transaction with a valid owner and response,
that evaluating the guard does not dereference a missing code, and that every
completion attempt leaves the callback spent. These conclusions assume the
reviewed closure skeleton and ordinary JavaScript execution.

The translator does not check the preceding preparation steps: it does not
prove how `pair`, `owner`, `config`, `discovery`, or `expiresAt` were obtained,
that `pair.state` is the state originally sent to the provider, that any of
those objects remain unchanged, or that the exchange and verifier implement
their contracts. Checking an argument name is not a proof of the security of
PKCE, a nonce, endpoint discovery, or token validation.

The evidence custody proof checks the exact synchronous source shape of
`consumeNativeOidcProof`, including deletion before the owner callback and
expiry check. It checks that the private `WeakMap` has only the reviewed uses
and that registration allocates a fresh proof object. Lean checks the resulting
abstract custody decision: acceptance requires a registered handle, a current
owner and an unexpired claim; a consumption attempt removes the handle; and a
reentrant or later attempt cannot consume it again. The proof assumes ordinary
single-agent JavaScript and unmodified built-ins, valid immutable stored values,
and a faithful structural checker. It does not check how claims were verified,
what the owner callback does, the rest of issuance, garbage collection, or
local admission.

The WebAuthn proof checks the actual assertion verifier's source prefix through
challenge consumption and purpose/principal checks. It proves that an
assertion can reach the signature verifier only for a present challenge whose
purpose is authentication or transaction, matches the caller's expected
purpose, and whose principal binding is satisfied. An omitted expected purpose
means authentication. The checker compares TypeScript tokens, preserving
literal contents and token boundaries. Store results and principal comparison
are abstracted; the proof does not establish challenge uniqueness, store
atomicity, signature validity, RP ID or origin verification, user verification,
transaction digest binding, or WebAuthn standards conformance.

The passkey-custody proof checks token snapshots of the complete seam and
in-memory store functions, including registration generation, verification,
counter updates, removal and record copying. The Lean abstraction checks that
acceptance requires a present, verified, matching registration and an allowed
counter, that zero counters require a stored zero, and that accepted positive
counters exceed the stored value. It assumes a faithful manual abstraction,
unique UUIDs for new registrations, the JavaScript runtime and byte copies;
pre-existing records may lack a generation. The proof does not establish
cryptographic verification, database atomicity, custom store correctness,
revocation after confirmation, or WebAuthn conformance.

The issuer-trust proof checks reviewed token snapshots of the selector and its
local helpers. The abstract Lean selector establishes that a nonempty issuer
uses static, then admitted organization, then active visitor configuration,
and that an empty or unmatched issuer is denied. Organization admission and
the repository results are inputs to the abstraction. The checker and manual
translation are trusted; the proof does not establish issuer ownership,
approval policy, credential binding, or atomicity across asynchronous reads.
An organization not admitted by its source can fall through to an active
visitor record; a later revocation does not retroactively erase a decision.

The federation pending-cookie proof checks reviewed token snapshots of the
schema, verifier binding, modern and legacy signatures, canonical base64url
encoding, verification and decoding. The Lean abstraction establishes that a
legacy signature is admitted only for legacy static provenance: a signed,
nonempty provider identifier and no field outside the former signed field set.
A valid modern signature admits the exact canonical encoded payload. The real
implementation
uses a version-specific derived HMAC key so a modern signature cannot be
reinterpreted as a legacy signature. HMAC, scrypt, JSON and base64url are
trusted primitives; this does not prove cookie delivery, expiry, replay
prevention, issuer trust or the later federation exchange.

The federation trust-binding proof checks reviewed token snapshots of the
start-time provenance selector and callback-time matching predicate. It also
checks that the start path records the resolved provenance and that completion
re-resolves and binds the authority before choosing credentials or making a
network request. Lean proves the abstract guard rejects a different source, a
replacement record, ambiguous provenance, an OAuth2 cookie on the OIDC leg,
and a legacy cookie reinterpreted as organization or visitor trust. The source
checker and its manual Boolean abstraction remain trusted. The proof assumes
the pending cookie has already passed the separately checked integrity gate;
it does not establish repository atomicity, issuer ownership, credential
secrecy, discovery, token exchange, claim verification or OIDC conformance.

The device-authorization, claim, agent-registration and resource proofs
extract the actual private Map/Set tables after checking their declared state
unions and membership functions. Lean checks every pair of states against
independently stated graphs. These graph proofs do not cover the operations
that call the tables, expiry, authorization, concurrency or persistence.

The claim-completion proof also checks the full `completeClaim` function's
token sequence, then proves that a call reaches `apply` only after its expiry
check returns normally, the claim is reviewed, and the supplied principal
identifier is nonempty. It does not prove that this identifier is authenticated,
that `assertNotExpired` or `apply` satisfy their contracts, or that the caller
is authorized to settle the claim.

The SAML proof checks the complete synchronous native replay-custody function,
including pruning, the issuer/assertion-ID key, the expiry and capacity tests,
and insertion. Lean proves that a live assertion is admitted exactly when its
key is not retained and custody is not full, and that admission records the
key so an immediate repeated claim is denied. This assumes finite clock and
expiry numbers, valid string keys and ordinary unmodified built-ins; it does
not prove signature or SAML protocol validation, durable or cross-process
custody, or behavior after expiry or restart.

## Trust boundary

The TypeScript parser and the translators in this directory are trusted code,
not themselves formally verified. They
accept only the supported source shapes and fail on unknown expressions,
statements in the translated decisions, table references, reassignment and
changed status domains. The OIDC transaction preparation preceding the
callback is outside that checked subset. Review
the translator whenever expanding that subset; a successful Lean run proves the
generated Lean definitions, conditional on the translation being faithful.

The correspondence assumes well-typed primitive method and Origin strings,
well-formed configuration, ordinary unmodified JavaScript built-ins, and no
hostile mutation of the private tables, a principal snapshot, OIDC transaction
bindings or configuration during a call. It
abstracts URL parsing and allowlist membership as facts; it does not verify the
JavaScript engine, TypeScript type erasure, repository contents, URL standard, browser cookie
behavior, or middleware composition. These proofs do not establish OAuth,
OIDC, SAML or any other complete authentication standard's conformance.

Run with the pinned Lean executable available on `PATH`, or set `LEAN_BIN`:

```sh
LEAN_BIN=/path/to/lean npm run verify:auth-source
```

Prerelease qualification runs the same command after installing the reviewed
Lean release. A source edit that changes a covered decision must pass the proof and
negative controls; a previously generated result is never reused.
