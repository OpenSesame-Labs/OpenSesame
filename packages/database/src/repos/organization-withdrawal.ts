import { isCanonicalUuid } from "../uuid.js";
import type { OrganizationMembershipWithdrawal } from "./organization-interfaces.js";

const removalReasons = new Set([
  "organization_owner_removed",
  "scim_deactivated",
  "ldap_directory_sync",
]);
const roles = new Set(["owner", "admin", "member"]);

// `id`, `actorPrincipalId` and `correlationId` are typed strings on
// OrganizationMembershipWithdrawal; only the UUID shape needs proving.
function validMetadata(withdrawal: OrganizationMembershipWithdrawal): boolean {
  return (
    !!withdrawal &&
    isCanonicalUuid(withdrawal.id) &&
    (withdrawal.actorType === "human" || withdrawal.actorType === "system")
  );
}

export function validOrganizationWithdrawal(
  withdrawal: OrganizationMembershipWithdrawal,
): boolean {
  if (!validMetadata(withdrawal)) return false;
  if (withdrawal.kind === "remove") {
    return (
      withdrawal.role === undefined &&
      (withdrawal.reason === undefined || removalReasons.has(withdrawal.reason))
    );
  }
  return (
    withdrawal.kind === "change_role" &&
    withdrawal.reason === undefined &&
    roles.has(withdrawal.role)
  );
}
