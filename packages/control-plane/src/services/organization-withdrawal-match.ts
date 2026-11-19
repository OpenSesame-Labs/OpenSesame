import type {
  OrganizationMembershipWithdrawal,
  VersionedOrganizationMembership,
} from "@opensesame/database";
import type { OrganizationRole } from "@opensesame/os-domain";

export type WithdrawalInput = {
  organizationId: string;
  principalId: string;
  expectedIncarnation?: string;
  actorPrincipalId: string;
  actorType: "human" | "system";
  correlationId: string;
  reason?:
    | "organization_owner_removed"
    | "scim_deactivated"
    | "ldap_directory_sync";
};

export type WithdrawalRequest =
  | { kind: "remove" }
  | { kind: "change_role"; role: OrganizationRole };

export function sameWithdrawal(
  pending: OrganizationMembershipWithdrawal,
  actorType: "human" | "system",
  reason: unknown,
  request: WithdrawalRequest,
): boolean {
  return (
    pending.kind === request.kind &&
    pending.actorType === actorType &&
    (request.kind !== "remove" || pending.reason === reason) &&
    (request.kind !== "change_role" ||
      (pending.kind === "change_role" && pending.role === request.role))
  );
}

export function expectedMembership(
  current: VersionedOrganizationMembership | undefined,
  expectedIncarnation?: string,
): current is VersionedOrganizationMembership {
  return Boolean(
    current &&
      (!expectedIncarnation || current.incarnation === expectedIncarnation),
  );
}
