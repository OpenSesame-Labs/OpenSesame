import { randomUUID } from "node:crypto";
import type {
  OrganizationMembershipStore,
  OrganizationMembershipWithdrawal,
  VersionedOrganizationMembership,
} from "@opensesame/database";
import type { OrganizationRole } from "@opensesame/os-domain";
import type {
  FinishWithdrawalResult,
  PreparedWithdrawal,
  WithdrawalInput,
  WithdrawalRequest,
} from "./organization-withdrawal.js";

export function newWithdrawal(
  input: WithdrawalInput,
  request: WithdrawalRequest,
): OrganizationMembershipWithdrawal {
  const details = {
    id: randomUUID(),
    actorPrincipalId: input.actorPrincipalId,
    actorType: input.actorType,
    correlationId: input.correlationId,
  };
  if (request.kind !== "remove") {
    return { ...details, kind: "change_role", role: request.role };
  }
  // Two literals rather than a conditional spread: a withdrawal without a
  // reason and one carrying `reason: undefined` are different records.
  return input.reason
    ? { ...details, kind: "remove", reason: input.reason }
    : { ...details, kind: "remove" };
}

export function mustProtectOwner(
  current: VersionedOrganizationMembership,
  input: WithdrawalInput,
  request: WithdrawalRequest,
): boolean {
  return (
    current.membership.role === "owner" &&
    !(request.kind === "remove" && input.actorType === "system")
  );
}

/** Resume or supersede an already-fenced membership without opening the fence. */
export async function existingWithdrawal(
  store: OrganizationMembershipStore,
  input: WithdrawalInput,
  request: WithdrawalRequest,
  current: VersionedOrganizationMembership,
): Promise<
  | { status: "ready"; prepared: PreparedWithdrawal }
  | { status: "busy" }
  | { status: "retry" }
> {
  const existing = current.withdrawal;
  if (!existing || !current.withdrawalId) return { status: "busy" };
  if (
    request.kind === "remove" &&
    input.actorType === "system" &&
    existing.kind === "change_role"
  ) {
    const withdrawal: OrganizationMembershipWithdrawal = {
      id: current.withdrawalId,
      kind: "remove",
      actorType: "system",
      actorPrincipalId: input.actorPrincipalId,
      correlationId: input.correlationId,
    };
    // Added only when present: a system removal without a reason and one
    // carrying `reason: undefined` are different records to the store.
    if (input.reason) withdrawal.reason = input.reason;
    const upgraded = await store.upgradeRoleWithdrawalToRemoval(
      input.organizationId,
      input.principalId,
      current.incarnation,
      current.authorityRevision,
      current.withdrawalId,
      withdrawal,
    );
    return upgraded
      ? {
          status: "ready",
          prepared: { ...current, withdrawalId: withdrawal.id, withdrawal },
        }
      : { status: "retry" };
  }
  const same =
    existing.kind === request.kind &&
    existing.actorType === input.actorType &&
    (request.kind !== "remove" || existing.reason === input.reason) &&
    (request.kind !== "change_role" ||
      (existing.kind === "change_role" && existing.role === request.role));
  return same
    ? {
        status: "ready",
        prepared: {
          ...current,
          withdrawalId: current.withdrawalId,
          withdrawal: existing,
        },
      }
    : { status: "busy" };
}

/** Classify a replay before making any Host call. Undefined means it is current. */
export function withdrawalOutcome(
  current: VersionedOrganizationMembership | undefined,
  prepared: PreparedWithdrawal,
): FinishWithdrawalResult | undefined {
  const { withdrawal, incarnation, authorityRevision } = prepared;
  if (!current)
    return { status: withdrawal.kind === "remove" ? "removed" : "stale" };
  if (current.incarnation !== incarnation) return { status: "stale" };
  if (
    !current.withdrawal &&
    withdrawal.kind === "change_role" &&
    current.membership.role === withdrawal.role &&
    current.authorityRevision !== authorityRevision
  )
    return { status: "changed", membership: current.membership };
  if (
    current.withdrawalId !== withdrawal.id ||
    current.authorityRevision !== authorityRevision ||
    current.withdrawal?.kind !== withdrawal.kind ||
    (withdrawal.kind === "change_role" &&
      (current.withdrawal.kind !== "change_role" ||
        current.withdrawal.role !== withdrawal.role))
  )
    return { status: "stale" };
  return undefined;
}

export function roleOutcomeAfterRace(
  after: VersionedOrganizationMembership | undefined,
  prepared: PreparedWithdrawal,
  role: OrganizationRole,
): FinishWithdrawalResult {
  return after &&
    after.incarnation === prepared.incarnation &&
    !after.withdrawalId &&
    after.authorityRevision !== prepared.authorityRevision &&
    after.membership.role === role
    ? { status: "changed", membership: after.membership }
    : { status: "stale" };
}
