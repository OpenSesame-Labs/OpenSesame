/**
 * `OrgOwner<A, O>` — the actor named `A` holds the `owner` role in the live
 * organization named `O` (ADR 0178).
 *
 * This is the only module that can mint the proof: the prover stays private,
 * and `no-define-proof` / `no-exported-prover` hold the line. It replaces four
 * hand-written `requireOwner` helpers that each re-implemented the lookup, the
 * liveness test and the 404-versus-403 split, and drifted on the middle one.
 *
 * Wire behaviour is preserved by returning a verdict rather than throwing: an
 * organization the caller has no membership in is `404 not_found` (the id space
 * is not enumerable), a member who is not an owner is `403 owner_required`.
 */

import { type Named, type Proof, defineProof } from "@gdp-ts/core";
import type {
  Organization,
  OrganizationMembership,
} from "@opensesame/os-domain";
import type { ActorId, OrganizationId } from "../lib/ids.js";
import type { AppStores } from "../state.js";

const OrgOwner = defineProof("OrgOwner");

/** Membership authority excludes rows already fenced for withdrawal. */
export async function authorizedOrganizationMembership(
  stores: Pick<AppStores, "organizationMemberships">,
  organizationId: string,
  principalId: string,
): Promise<OrganizationMembership | undefined> {
  const versioned = await stores.organizationMemberships.findVersioned(
    organizationId,
    principalId,
  );
  return versioned?.withdrawalId ? undefined : versioned?.membership;
}
export interface OrgOwner<A, O> extends Proof<"OrgOwner", [A, O]> {}

/**
 * Which organization states still let an owner act.
 *
 * `not_deleted` is what organizations, domains and LDAP have always accepted,
 * so a suspended organization's owner can still reach them to fix it.
 * `active` is the stricter reading SCIM provisioning has always used.
 * Membership and provisioning administration require `active`. Recovery
 * surfaces that can make a suspended organization usable again may use
 * `not_deleted`; no owner proof may skip the organization-state check.
 */
export type OrgLiveness = "not_deleted" | "active";

export type OrgOwnerVerdict<A, O> =
  | {
      readonly ok: true;
      readonly proof: OrgOwner<A, O>;
      readonly organization: Organization;
    }
  | {
      readonly ok: false;
      readonly status: 403 | 404;
      readonly error: "not_found" | "owner_required";
    };

export async function orgOwner<A, O>(
  stores: Pick<AppStores, "organizations" | "organizationMemberships">,
  actor: Named<A, ActorId>,
  org: Named<O, OrganizationId>,
  liveness: OrgLiveness,
): Promise<OrgOwnerVerdict<A, O>> {
  const organization = await stores.organizations.get(org.value);
  const membership = organization
    ? await authorizedOrganizationMembership(
        stores,
        organization.id,
        actor.value,
      )
    : undefined;
  const live =
    organization !== undefined &&
    (liveness === "active"
      ? organization.state === "active"
      : organization.state !== "deleted");
  if (!organization || !live || !membership) {
    return { ok: false, status: 404, error: "not_found" };
  }
  if (membership.role !== "owner") {
    return { ok: false, status: 403, error: "owner_required" };
  }
  return { ok: true, proof: OrgOwner.prove(actor, org), organization };
}
