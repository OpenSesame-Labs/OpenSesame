import type { AppContext } from "../context.js";
import {
  FederatedAuthError,
  type FederatedIdentity,
  type PendingFederatedAuth,
  completeFederatedAuth,
} from "./federated.js";
import { completeOAuth2Auth } from "./oauth2.js";
import { normalizeIssuer, providerById } from "./registry.js";

/**
 * Complete whichever leg started this (C3/C4).
 *
 * `kind` rides in the pending cookie and an absent one means `"oidc"` — the
 * shape of every cookie written before this release. An `"oauth2"` pending
 * must never be finished by the OIDC leg: that leg's whole guarantee is a
 * JWKS-verified id_token, and a provider that issues none would otherwise be
 * admitted on whatever its token endpoint happened to return.
 */
export async function completeFederatedLeg(
  ctx: AppContext,
  pending: PendingFederatedAuth,
  currentUrl: URL,
): Promise<FederatedIdentity> {
  if ((pending.kind ?? "oidc") !== "oauth2") {
    return completeFederatedAuth(ctx, pending, currentUrl);
  }
  const descriptor = pending.providerId
    ? providerById(ctx.config, pending.providerId)
    : undefined;
  if (
    descriptor?.kind !== "oauth2" ||
    normalizeIssuer(descriptor.issuer) !== normalizeIssuer(pending.issuer)
  ) {
    // The cookie named a provider this deployment no longer offers, or one
    // whose issuer it does not match. Either way, nothing vouches for it.
    throw new FederatedAuthError(
      "untrusted_issuer",
      "That sign-in provider is not trusted by this server",
    );
  }
  return completeOAuth2Auth(ctx, descriptor, pending, currentUrl);
}
