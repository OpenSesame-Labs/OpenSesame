import { isCanonicalUuid } from "../uuid.js";
import type { OrganizationMembershipWithdrawal } from "./organization-interfaces.js";

const removalReasons = new Set([
  "organization_owner_removed",
  "scim_deactivated",
  "ldap_directory_sync",
]);
const roles = new Set(["owner", "admin", "member"]);

function validMetadata(withdrawal: OrganizationMembershipWithdrawal): boolean {
  return (
    !!withdrawal &&
    typeof withdrawal.id === "string" &&
    isCanonicalUuid(withdrawal.id) &&
    (withdrawal.actorType === "human" || withdrawal.actorType === "system") &&
    typeof withdrawal.actorPrincipalId === "string" &&
    typeof withdrawal.correlationId === "string"
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
