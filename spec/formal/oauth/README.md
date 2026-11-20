# Federated pending state integrity

This slice covers the hosted federated sign-in cookie and its provenance checks.
It does not prove OAuth or OpenID Connect as a whole. The current cookie format
authenticates the exact encoded payload, including its issuer, state, nonce,
verifier, leg kind, provider, bring-your-own record, and organization. It keeps
the v3 format already used by main, including its separately derived MAC key.
The legacy MAC authenticates its old fields after default normalization: absent
`kind` is equivalent to `"oidc"`, and absent `providerId` to `""`.
Both absent and empty provider IDs are refused because neither identifies a
signed static provider. When a
pending state names an authority, the callback must also check that the same
authority still vouches for the issuer before exchanging the code and before
account or organization effects. See the
[federated sign-in contract](../../../docs/architecture/federated-signin.md).

| ID | Requirement | Lean property | Implementation evidence |
|---|---|---|---|
| FED-I1 | The current domain-separated MAC input binds the encoded payload and verifier binding. | `current_message_binds_payload`, `current_message_binds_verifier` | `encodePending` and `decodePending` use a tag over the exact encoded payload and the scrypt-bound verifier; the security test changes each field and an unknown future field. |
| FED-I2 | A legacy tag requires a nonempty signed static-provider ID and cannot authorize organization, bring-your-own, or unknown provenance that its MAC did not cover. | `legacy_rejects_missing_provider`, `legacy_rejects_organization`, `legacy_rejects_byo`, `legacy_rejects_unknown`, `legacy_rejects_invalid_tag`, `legacy_byo_strip_rejected`, `legacy_organization_strip_rejected`, `legacy_static_signed_provider_accepted` | Thirty-two Lean-generated tag and provenance cases exercise `decodePending`; separate regressions strip unsigned organization and BYO IDs. |
| FED-I3 | For OIDC, every supplied provider, bring-your-own, or organization identifier must match the source and identifier of current trust. Without provenance only a static source is accepted. | `accepted_provider_matches`, `accepted_byo_matches`, `accepted_organization_matches`, `missing_provenance_only_static` | Eighty-one Lean-generated cases exercise `trustMatchesPending`. Hosted-route tests cover a normal organization sign-in and issuer reassignment during an in-flight sign-in. An exchange-level test changes trust after the initial lookup and checks that the lookup selecting credentials refuses before discovery. |
| FED-I4 | The v3 MAC binds the scrypt verifier digest, not the wire encoding of the PKCE verifier. | `wire_encoding_does_not_change_mac_binding` | `encodePending` defaults to plaintext `verifier` on the wire (`federatedPendingSealVerifierOnWire` off) so mixed-version control-plane replicas keep decoding in-flight cookies; optional `verifierEnc` seals the verifier when every replica can unseal. Security tests cover both wire shapes, mixed-field rejection, and production route options. |

`coverage.json` records the reviewed base commit and hashes identifying the
reviewed pending-state, exchange and callback bytes. The hashes signal
unreviewed drift; they are not proof of correctness. The legacy
format is accepted only when its payload has no fields outside the old signed
field set and carries a nonempty signed provider ID. Explicit default `kind`
remains equivalent to its absence; absent and empty provider IDs are both
refused. Legacy organization, bring-your-own, providerless and other unsigned
states must restart, even if their issuer is now statically trusted. Cookies already emitted in
main's v3 format continue to verify. A v3 cookie will not verify on a node that
only implements the legacy format, so mixed-version rollouts can temporarily
interrupt sign-in. Deployments should plan the rollout and monitor failures.

Run with Lean 4.24.0 and the repository's Node dependencies:

```sh
npm run verify:oauth-formal
python3 spec/formal/oauth/negative-controls.py
```

Set `OPENSESAME_LEAN_BIN` to the Lean executable when it is not on `PATH`. The
check rejects Lean warnings and theorem dependencies on unapproved axioms,
compares model vectors with the actual TypeScript functions, runs the hosted
flow regressions, and checks source hashes. The scratch negative controls remove
the current payload binding, allow legacy provenance or a missing signed
provider, skip the legacy MAC, and remove the current organization-ID comparison; each must trigger a failing assertion. The normal
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
is unforgeable; it does not prove either cryptographic assumption or the scrypt
implementation. Finite correspondence testing is not a proof of TypeScript
refinement for all inputs. The trust checks are separate reads, not an atomic
transaction with issuer configuration and membership writes. The OIDC leg
checks provenance against the same trust result used to select its client mode,
but a concurrent change after that read remains outside the model. The suite
does not prove PKCE, upstream state and nonce validation, redirects,
ID-token/JWT signatures, issuer ownership, session creation, or the rest of the
OAuth/OIDC protocol. The OAuth2 callback wrapper requires an unchanged static
OAuth2 provider, but its behavior is tested and is not modeled by FED-I3.
Unsigned cookies used when no secret is supplied are also outside FED-I1.
