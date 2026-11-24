# Federated pending state integrity

This slice covers the hosted federated sign-in cookie and its provenance checks.
It does not prove OAuth or OpenID Connect as a whole. The current (v4) cookie
format authenticates the exact encoded payload, including its issuer, state,
nonce, sealed verifier (`verifierEnc`), leg kind, provider, bring-your-own
record, and organization, with HMAC-SHA-256 under a v4-only derived key. The
tag is checked before the payload is parsed, unsealed or given to any key
derivation, and no slow password hash (scrypt or similar) runs anywhere in the
codec. Every earlier signed format (v3 and the pre-v3 legacy tag) bound a
scrypt digest of the verifier, so verifying it meant running scrypt on
unauthenticated input; those cookies are refused and their sign-ins restart
(the cookie's max-age is ten minutes). When a
pending state names an authority, the callback must also check that the same
authority still vouches for the issuer before exchanging the code and before
account or organization effects. See the
[federated sign-in contract](../../../docs/architecture/federated-signin.md).

| ID | Requirement | Lean property | Implementation evidence |
|---|---|---|---|
| FED-I1 | The current domain-separated MAC input binds the encoded payload, which carries the sealed verifier. | `current_message_binds_payload`, `current_message_binds_verifier` | v4 `pendingMac` tags `MAC_DOMAIN ‖ payload`; the model's `SealedPayload` has exactly the fields of the strict `sealedWireSchema`, including `verifierEnc`. The security test changes each field and an unknown future field; the 160 Lean-generated `v4` cases include valid-tag cookies under every wire shape. **Proved** (Lean 4.24.0, 2026-11-24). |
| FED-I2 | No legacy (pre-v4) cookie is accepted: a legacy payload carries a plaintext verifier, so it fails the strict sealed wire shape whatever its tag, and cannot authorize organization, bring-your-own, unknown or static-provider provenance. | `legacy_never_accepted`, `legacy_rejects_missing_provider`, `legacy_rejects_organization`, `legacy_rejects_byo`, `legacy_rejects_unknown`, `legacy_rejects_invalid_tag`, `legacy_byo_strip_rejected`, `legacy_organization_strip_rejected`, `legacy_static_signed_provider_refused` | `acceptsLegacy` is now the v4 decoder applied to a plaintext-verifier payload, matching the implementation, which refuses every legacy tag. The thirty-two Lean-generated cases require `decodePending` to agree exactly (every one refused, including valid legacy tags). Separate regressions strip unsigned organization and BYO IDs. **Proved** (Lean 4.24.0, 2026-11-24). |
| FED-I3 | For OIDC, every supplied provider, bring-your-own, or organization identifier must match the source and identifier of current trust. Without provenance only a static source is accepted. | `accepted_provider_matches`, `accepted_byo_matches`, `accepted_organization_matches`, `missing_provenance_only_static` | Eighty-one Lean-generated cases exercise `trustMatchesPending`. Hosted-route tests cover a normal organization sign-in and issuer reassignment during an in-flight sign-in. An exchange-level test changes trust after the initial lookup and checks that the lookup selecting credentials refuses before discovery. |
| FED-I4 | The pending-cookie MAC is verified over the exact encoded payload before any parsing, verifier unsealing or key derivation; no slow KDF runs on cookie input; the verifier travels only sealed. | `mac_first`, `invalid_tag_no_work`, `accepted_requires_valid_tag`, `accepted_requires_sealed_only`, `accepted_derives_once`, `derivations_at_most_one`, `no_slow_hash` | `decodeTrace` models `decodeSigned` step by step (length cap and shape check, then `mac`, `parse`, `deriveKey`, `unseal`). 160 Lean-generated `v4` cases (oversize, shape, tag, five wire shapes, leg-binding and seal validity) build real cookies and require `decodePending` to match the modelled acceptance with real keys, and the modelled number of derivations through a counting `PendingCookieKeys` seam. Security tests also fail if the codec calls scrypt, PBKDF2, Argon2 or bcrypt. `v3_slow_hash_before_mac` records, for contrast, that the retired v3 decoder violated the property. **Proved** for the model (Lean 4.24.0, 2026-11-24); see the limits below. |

`coverage.json` records the reviewed base commit and hashes identifying the
reviewed pending-state, exchange and callback bytes. The hashes signal
unreviewed drift; they are not proof of correctness. No pre-v4 signed cookie
is accepted: legacy organization, bring-your-own, providerless, static-provider
and v3 cookies all restart. A v4 cookie will not verify on a node that only
implements v3 (and the reverse), so a mixed-version rollout interrupts sign-ins
started on the other version until the ten-minute cookie expires; those users
start the sign-in again.

Run with Lean 4.24.0 and the repository's Node dependencies:

```sh
npm run verify:oauth-formal
python3 spec/formal/oauth/negative-controls.py
node --test spec/formal/oauth/check-hosted-flow-report.test.mjs
python3 spec/formal/oauth/hosted-flow-negative-controls.py
```

Set `OPENSESAME_LEAN_BIN` to the Lean executable when it is not on `PATH`. The
check rejects Lean warnings and theorem dependencies on unapproved axioms,
compares model vectors with the actual TypeScript functions, runs the hosted
flow regressions, requires both named hosted-flow tests to pass in Vitest's JSON
report, and checks source hashes. A filtered run that skips or renames either
test fails the gate, including a run that selects no tests. The hosted-flow
negative controls rename and skip each case and exercise the complete gate from
a scratch tree; unchanged source and dependencies are linked, while mutations
are made only to a copied test file. The other scratch negative controls remove
the v4 payload binding or MAC comparison, admit a plaintext or mixed verifier,
derive a key before the MAC, and remove the current organization-ID comparison;
each must trigger a failing assertion. The normal
gate refuses the mutation override.

The owner-stripping model assumes that the issuing version only put a provider
ID on static-provider flows and that its MAC binds the provider-presence bit.
It models removal of unsigned owner fields and refuses a newly added provider
bit without that binding; it does not prove HMAC or model provider ID strings.
The legacy-provider rule assumes that provider IDs are not recycled for a
different authority and that the legacy MAC is unforgeable. It does not prove those
operational assumptions or a snapshot of the provider's credentials. The cookie
max-age and deletion instructions are client behavior, not server-side expiry
or one-use guarantees.

The current-message theorem models the domain label and a structured,
unambiguous payload. It assumes the actual base64url JSON encoding has that
property and that HMAC-SHA-256 is unforgeable; it does not prove either
cryptographic assumption or AES-GCM. FED-I4 is proved of the step model
`decodeTrace`: that the TypeScript decoder performs exactly those steps in that
order is established by source review and the finite correspondence cases
(acceptance and observed derivations), not by a proof over the TypeScript. The
`slowHash` step is absent from `decodeTrace` by construction; the evidence that
the code has no slow hash is the source review and the codec scan test. Since
2026-11-24 the step order is also proved for the code itself: `verify.sh` runs
the source translator in `spec/auth-verification/source`, which derives the
guard/work/accept program of the real `decodeSigned` statement by statement
(one fact per guard; a password-hash call becomes a `slowHash` step) and has
Lean prove it equal to the independent FED-I4 policy for every combination of
facts. What stays trusted is the translator's exact-token recognition of each
statement and its Boolean abstraction of each guard. A
legacy or v3 tag is modelled as invalid under the v4 key, which again assumes
HMAC is unforgeable; the legacy refusal itself does not depend on it, since a
plaintext verifier fails the strict schema. Finite correspondence testing is not a proof of TypeScript
refinement for all inputs. The trust checks are separate reads, not an atomic
transaction with issuer configuration and membership writes. The OIDC leg
checks provenance against the same trust result used to select its client mode,
but a concurrent change after that read remains outside the model. The suite
does not prove PKCE, upstream state and nonce validation, redirects,
ID-token/JWT signatures, issuer ownership, session creation, or the rest of the
OAuth/OIDC protocol. The OAuth2 callback wrapper requires an unchanged static
OAuth2 provider, but its behavior is tested and is not modeled by FED-I3.
Unsigned cookies used when no secret is supplied are also outside FED-I1.
