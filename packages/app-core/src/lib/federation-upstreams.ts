import type { TrustedUpstream } from "./federation-contract.js";

/**
 * Trust is configuration, not discovery: an issuer absent from this list is
 * refused even if it completes a flow correctly (ADR 0033 §2).
 */
export const TRUSTED_UPSTREAMS: readonly TrustedUpstream[] = [
  {
    id: "shoo",
    displayName: "Shoo",
    issuer: "https://shoo.dev",
    accountKind: "Google",
    authorizationEndpoint: "https://shoo.dev/authorize",
    tokenEndpoint: "https://shoo.dev/token",
    jwksUri: "https://shoo.dev/.well-known/jwks.json",
    protocol: "shoo",
    sessionCheckEndpoint: "https://shoo.dev/session/check",
  },
  {
    // Hermetic tests name this upstream explicitly. It is never the product
    // default — first run signs in through Shoo, which is a real OIDC broker.
    id: "mock",
    displayName: "Local mock IdP",
    issuer: "http://127.0.0.1:9090",
    accountKind: "a test account",
    authorizationEndpoint: "http://127.0.0.1:9090/authorize",
    tokenEndpoint: "http://127.0.0.1:9090/token",
    jwksUri: "http://127.0.0.1:9090/jwks",
  },
];

/**
 * The compiled-in broker is Shoo on every origin, including loopback.
 *
 * A self-hosted Identity API is optional plumbing (org SSO, SAML, magic
 * link, guest). It is not a requirement for first-run sign-in: this static
 * page is a public OIDC client of Shoo, which fronts Google — including
 * Google passkeys — and already serves CORS on `POST /token` for this origin.
 * The mock IdP stays in the allowlist so hermetic tests can name it.
 */
export function defaultUpstreamDefault(): TrustedUpstream {
  const found = TRUSTED_UPSTREAMS.find((u) => u.id === "shoo");
  if (!found) throw new Error('no trusted upstream "shoo"');
  return found;
}

export function upstreamByIssuer(issuer: string): TrustedUpstream | undefined {
  return TRUSTED_UPSTREAMS.find((u) => u.issuer === issuer);
}
