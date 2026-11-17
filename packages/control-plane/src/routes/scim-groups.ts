import type { Named } from "@gdp-ts/core";
import { appendAuditEvent } from "@opensesame/audit";
import type { ScimGroupRecord } from "@opensesame/database";
import type {
  JsonObject,
  Organization,
  OrganizationRole,
} from "@opensesame/os-domain";
import { isJsonObject } from "@opensesame/os-domain";
import type { Context } from "hono";
import type { AppContext } from "../context.js";
import type { OrganizationId } from "../lib/ids.js";
import type { Variables } from "../middleware/context.js";
import type { OrgOwner } from "../proofs/org-owner.js";
import { withScimOrganizationBoundary } from "../repos/scim-organization-boundary.js";
import {
  type PreparedWithdrawal,
  finishOrganizationWithdrawal,
} from "../services/organization-withdrawal.js";
import { SCIM_ROLE_ATTRIBUTE, applyRole, roleOf } from "./scim-effects.js";
import {
  memberIds,
  parseMemberSelector,
  resolveMemberIds,
} from "./scim-member-selector.js";
import {
  type ScimPatchOperation,
  boundedScimString,
  readScimJsonBody,
  scimAuditActor,
  scimBody,
  scimError,
  scimPatchOperations,
} from "./scim-protocol.js";

const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
const MAX_DISPLAY_LENGTH = 512;

const ROLE_RANK = {
  member: 1,
  admin: 2,
  owner: 3,
} as const;

export type ScimSession = {
  ctx: AppContext;
  organization: Organization;
};

/**
 * Kept exported so callers that used suffix mapping still compile. Privilege
 * is never inferred from a group name.
 */
export function roleForGroupName(_name: string): OrganizationRole | undefined {
  return undefined;
}

export { memberIds, parseMemberSelector };

/**
 * Map a directory group to an organization role. Mapping a group to `owner`
 * grants ownership to everyone in it, so this takes the owner's proof about the
 * exact organization rather than trusting the caller to have checked (ADR 0178).
 */
export async function putGroupRoleMapping<A, O>(
  ctx: AppContext,
  org: Named<O, OrganizationId>,
  _proof: OrgOwner<A, O>,
  groupId: string,
  role: OrganizationRole,
): Promise<void> {
  const orgId = org.value;
  const organization = await ctx.stores.organizations.get(orgId);
  if (!organization) return;
  const prepared = await withScimOrganizationBoundary(
    ctx,
    orgId,
    async (tx) => {
      await tx.stores.scim.mappings.put(orgId, groupId, role);
      const group = await tx.stores.scim.groups.getById(orgId, groupId);
      if (!group) return [];
      const pending: PreparedWithdrawal[] = [];
      for (const memberId of group.memberIds) {
        pending.push(
          ...(await syncDerivedRole(
            tx,
            organization,
            memberId,
            `scim-role-${groupId}`,
          )),
        );
      }
      return pending;
    },
  );
  await finishRoleChanges(ctx, prepared);
}

export async function patchScimGroup(
  c: Context<{ Variables: Variables }>,
  session: ScimSession,
): Promise<Response> {
  const { ctx, organization } = session;
  const body = await readScimJsonBody(c);
  if (!body) return scimError(c, 400, "Body is not a SCIM PatchOp.");
  const groupId = decodeURIComponent(c.req.param("groupId") ?? "");
  if (!groupId) return scimError(c, 400, "group id is required.");

  const operations = scimPatchOperations(body);
  const outcome = await withScimOrganizationBoundary(
    ctx,
    organization.id,
    async (tx) => {
      const existing = await tx.stores.scim.groups.getById(
        organization.id,
        groupId,
      );
      const folded = foldGroupPatch(body, operations, existing, groupId);
      if ("error" in folded) return folded;
      const now = ctx.clock();
      const stored = await tx.stores.scim.groups.upsert({
        id: groupId,
        organizationId: organization.id,
        displayName: folded.displayName,
        memberIds: folded.memberIds,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      const prepared: PreparedWithdrawal[] = [];
      for (const memberId of folded.affected) {
        prepared.push(
          ...(await syncDerivedRole(
            tx,
            organization,
            memberId,
            c.get("correlationId"),
          )),
        );
      }
      return { stored, affected: folded.affected, prepared };
    },
  );
  if ("error" in outcome)
    return scimError(c, 400, outcome.error.detail, outcome.error.scimType);
  await finishRoleChanges(ctx, outcome.prepared);
  for (const memberId of outcome.affected) {
    await auditDerivedRole(ctx, organization, memberId, c);
  }
  return scimBody(c, 200, groupResource(outcome.stored));
}

function groupResource(group: ScimGroupRecord): JsonObject {
  return {
    schemas: [GROUP_SCHEMA],
    id: group.id,
    displayName: group.displayName,
    members: group.memberIds.map((id) => ({ value: id })),
  };
}

function foldDisplayName(
  body: JsonObject,
  operations: ScimPatchOperation[],
  fallback: string,
): string {
  let displayName =
    boundedScimString(body.displayName, MAX_DISPLAY_LENGTH) ?? fallback;
  for (const operation of operations) {
    if (operation.path?.toLowerCase() !== "displayname") continue;
    if (operation.value === undefined) continue;
    displayName =
      boundedScimString(operation.value, MAX_DISPLAY_LENGTH) ?? displayName;
  }
  return displayName;
}

function targetsMembers(operation: ScimPatchOperation): boolean {
  if (operation.path !== undefined) {
    const path = operation.path.trim();
    return parseMemberSelector(path) !== undefined || /^members/i.test(path);
  }
  return isJsonObject(operation.value) && operation.value.members !== undefined;
}

function foldGroupPatch(
  body: JsonObject,
  operations: ScimPatchOperation[],
  existing: ScimGroupRecord | null,
  groupId: string,
):
  | { displayName: string; memberIds: string[]; affected: string[] }
  | { error: { detail: string; scimType: string } } {
  let memberList = existing ? [...existing.memberIds] : [];
  const affected = new Set<string>();
  for (const operation of operations) {
    if (!targetsMembers(operation)) continue;
    const resolved = resolveMemberIds(operation);
    if ("error" in resolved) return resolved;
    const applied = applyMemberOp(memberList, operation.op, resolved.ids);
    if ("error" in applied) return applied;
    for (const id of resolved.ids) affected.add(id);
    memberList = applied.memberIds;
  }
  return {
    displayName: foldDisplayName(
      body,
      operations,
      existing?.displayName ?? groupId,
    ),
    memberIds: memberList,
    affected: [...affected],
  };
}

function applyMemberOp(
  current: string[],
  op: string,
  ids: string[],
): { memberIds: string[] } | { error: { detail: string; scimType: string } } {
  if (op === "add") {
    const next = [...current];
    for (const id of ids) {
      if (!next.includes(id)) next.push(id);
    }
    return { memberIds: next };
  }
  if (op === "remove") {
    const drop = new Set(ids);
    return { memberIds: current.filter((id) => !drop.has(id)) };
  }
  return {
    error: {
      detail: "Bulk member replace is not supported.",
      scimType: "invalidValue",
    },
  };
}

function pickRole(
  current: OrganizationRole | undefined,
  next: OrganizationRole,
): OrganizationRole {
  if (!current) return next;
  return ROLE_RANK[next] > ROLE_RANK[current] ? next : current;
}

async function derivedRoleForUser(
  ctx: AppContext,
  orgId: string,
  memberId: string,
): Promise<OrganizationRole | undefined> {
  const groups = await ctx.stores.scim.groups.listByMember(orgId, memberId);
  let derived: OrganizationRole | undefined;
  for (const group of groups) {
    const mapped = await ctx.stores.scim.mappings.get(orgId, group.id);
    if (mapped) derived = pickRole(derived, mapped);
  }
  return derived;
}

/** Runs with the SCIM organization boundary already held. */
async function syncDerivedRole(
  ctx: AppContext,
  organization: Organization,
  memberId: string,
  correlationId: string,
): Promise<PreparedWithdrawal[]> {
  const current = await ctx.stores.scim.users.getVersioned(
    organization.id,
    memberId,
  );
  if (!current) return [];
  const user = current.user;
  const derived = await derivedRoleForUser(ctx, organization.id, memberId);
  const previous = roleOf(user);
  if (derived !== previous) {
    const raw = { ...user.raw };
    if (derived) raw[SCIM_ROLE_ATTRIBUTE] = derived;
    else delete raw[SCIM_ROLE_ATTRIBUTE];
    const replaced = await ctx.stores.scim.users.replaceIfRevision(
      organization.id,
      memberId,
      current.revision,
      { ...user, raw, updatedAt: ctx.clock() },
    );
    if (!replaced) throw new Error("SCIM user changed concurrently");
  }
  // Recheck even when the stored role is unchanged: a previous Host request
  // may have failed after persisting its role-change intent.
  return user.active
    ? applyRole(
        ctx,
        organization,
        user,
        derived ?? "member",
        correlationId,
        derived === undefined && previous === undefined,
      )
    : [];
}

async function finishRoleChanges(
  ctx: AppContext,
  prepared: PreparedWithdrawal[],
): Promise<void> {
  for (const change of prepared) {
    const result = await finishOrganizationWithdrawal(ctx, change);
    if (result.status !== "changed")
      throw new Error("Membership update is pending; retry the group update");
  }
}

async function auditDerivedRole(
  ctx: AppContext,
  organization: Organization,
  memberId: string,
  c: Context<{ Variables: Variables }>,
): Promise<void> {
  const user = await ctx.stores.scim.users.getById(organization.id, memberId);
  if (!user) return;
  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "organization.scim_role_mapped",
    outcome: "succeeded",
    organizationId: organization.id,
    correlationId: c.get("correlationId"),
    ...scimAuditActor(c),
    targetType: "scim_user",
    targetId: user.id,
    metadata: {
      action: "organization.scim_group.map_role",
      type: roleOf(user) ?? "member",
    },
  });
}
