import { normalizeIssuer } from "./issuer-normalization.js";
import type { PendingFederatedAuth } from "./federated-pending.js";
import type { TrustResolution } from "./trust.js";

/**
 * Prove that the authority recorded when a federated leg started is the same
 * authority that resolves its issuer now. This check is repeated after the
 * exchange so a trust-source change cannot redirect a still-live leg.
 */
export function pendingMatchesTrust(
  pending: PendingFederatedAuth,
  trust: TrustResolution,
): boolean {
  const issuer = normalizeIssuer(pending.issuer);
  if (!issuer) return false;

  const isLegacy =
    (pending.kind === undefined || pending.kind === "oidc") &&
    pending.providerId === undefined &&
    pending.byoId === undefined &&
    pending.orgId === undefined;
  if (isLegacy) {
    return (
      trust.source === "static" &&
      trust.provider.kind === "oidc" &&
      issuer === normalizeIssuer(trust.provider.issuer)
    );
  }

  if (pending.providerId !== undefined) {
    return (
      trust.source === "static" &&
      pending.kind === trust.provider.kind &&
      pending.providerId === trust.provider.id &&
      issuer === normalizeIssuer(trust.provider.issuer) &&
      pending.byoId === undefined &&
      pending.orgId === undefined
    );
  }
  if (pending.byoId !== undefined) {
    return (
      trust.source === "byo" &&
      pending.kind === "oidc" &&
      pending.byoId === trust.record.id &&
      issuer === normalizeIssuer(trust.record.issuer) &&
      pending.orgId === undefined
    );
  }
  return (
    pending.orgId !== undefined &&
    trust.source === "org" &&
    pending.kind === "oidc" &&
    pending.orgId === trust.organizationId &&
    issuer === normalizeIssuer(trust.issuer)
  );
}
