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
| FED-I1 | The current domain-separated MAC input binds the encoded payload, which carries the sealed verifier. | `current_message_binds_payload`, `current_message_binds_verifier` | v4 `encodePending` and `decodePending` tag the exact encoded payload; the security test changes each field and an unknown future field. The Lean pair abstraction still holds with the verifier binding taken as the sealed field inside the payload; that mapping was re-reviewed on 2026-11-23 but Lean was not re-run. |
| FED-I2 | A legacy tag requires a nonempty signed static-provider ID and cannot authorize organization, bring-your-own, or unknown provenance that its MAC did not cover. | `legacy_rejects_missing_provider`, `legacy_rejects_organization`, `legacy_rejects_byo`, `legacy_rejects_unknown`, `legacy_rejects_invalid_tag`, `legacy_byo_strip_rejected`, `legacy_organization_strip_rejected`, `legacy_static_signed_provider_accepted` | Since v4 the implementation refuses every legacy tag, so it refines the model conservatively: the thirty-two Lean-generated cases check that `decodePending` never accepts a case the model refuses, and that it also refuses the model's admitted static-provider cases. `legacy_static_signed_provider_accepted` no longer describes implementation behaviour. Separate regressions strip unsigned organization and BYO IDs. |
| FED-I3 | For OIDC, every supplied provider, bring-your-own, or organization identifier must match the source and identifier of current trust. Without provenance only a static source is accepted. | `accepted_provider_matches`, `accepted_byo_matches`, `accepted_organization_matches`, `missing_provenance_only_static` | Eighty-one Lean-generated cases exercise `trustMatchesPending`. Hosted-route tests cover a normal organization sign-in and issuer reassignment during an in-flight sign-in. An exchange-level test changes trust after the initial lookup and checks that the lookup selecting credentials refuses before discovery. |
| FED-I4 | The pending-cookie MAC is verified over the exact encoded payload before any parsing, verifier unsealing or key derivation; no slow KDF runs on cookie input; the verifier travels only sealed. | **Unproved.** `wire_encoding_does_not_change_mac_binding` modelled the retired v3 scrypt binding and no longer corresponds to the implementation. | 2026-11-23 (v4): security tests count key derivations through the `PendingCookieKeys` seam (forged, oversize, wrong-pepper, v3 and plaintext-verifier cookies cause none; a valid cookie causes one), refuse plaintext and mixed verifier shapes even under a valid v4 tag, refuse v3 and legacy cookies, and fail if the codec calls scrypt, PBKDF2, Argon2 or bcrypt. The negative controls remove the MAC comparison, the payload binding and schema strictness, and derive a key before the MAC. The `OPENSESAME_FEDERATED_PENDING_SEAL_VERIFIER` rollout flag is removed. |

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

The current-message theorem models a structured, unambiguous pair. It assumes
the actual domain-separated encoding has that property and that HMAC-SHA-256
is unforgeable; it does not prove either cryptographic assumption, AES-GCM, or
that HMAC verification precedes parsing (FED-I4 is tested, not proved). Finite correspondence testing is not a proof of TypeScript
refinement for all inputs. The trust checks are separate reads, not an atomic
transaction with issuer configuration and membership writes. The OIDC leg
checks provenance against the same trust result used to select its client mode,
but a concurrent change after that read remains outside the model. The suite
does not prove PKCE, upstream state and nonce validation, redirects,
ID-token/JWT signatures, issuer ownership, session creation, or the rest of the
OAuth/OIDC protocol. The OAuth2 callback wrapper requires an unchanged static
OAuth2 provider, but its behavior is tested and is not modeled by FED-I3.
Unsigned cookies used when no secret is supplied are also outside FED-I1.
