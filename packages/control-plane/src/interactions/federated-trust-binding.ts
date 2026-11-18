import type { PendingFederatedAuth } from "./federated-pending.js";
import type { TrustResolution } from "./trust.js";

/** The pending-cookie provenance a resolved authority contributes at start. */
export function pendingProvenance(
  trust: TrustResolution,
): Pick<PendingFederatedAuth, "kind" | "providerId" | "byoId" | "orgId"> {
  if (trust.source === "static") {
    return { kind: trust.provider.kind, providerId: trust.provider.id };
  }
  if (trust.source === "byo") {
    return { kind: "oidc", byoId: trust.record.id };
  }
  return { kind: "oidc", orgId: trust.organizationId };
}

/** Require the callback authority to be the exact authority that began it. */
export function trustMatchesPending(
  trust: TrustResolution,
  pending: PendingFederatedAuth,
): boolean {
  if ((pending.kind ?? "oidc") !== "oidc") return false;
  const provenanceCount = [
    pending.providerId,
    pending.byoId,
    pending.orgId,
  ].filter((value) => value !== undefined).length;
  if (provenanceCount > 1) return false;
  if (pending.providerId !== undefined) {
    return (
      trust.source === "static" &&
      trust.provider.id === pending.providerId &&
      trust.provider.kind === "oidc"
    );
  }
  if (pending.byoId !== undefined) {
    return trust.source === "byo" && trust.record.id === pending.byoId;
  }
  if (pending.orgId !== undefined) {
    return trust.source === "org" && trust.organizationId === pending.orgId;
  }
  // Cookies from before provenance fields existed could only have started from
  // the static provider set. Do not reinterpret one as tenant or visitor trust.
  return trust.source === "static" && trust.provider.kind === "oidc";
}
