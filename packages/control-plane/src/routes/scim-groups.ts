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
import type { ActorId, OrganizationId } from "../lib/ids.js";
import type { Variables } from "../middleware/context.js";
import { type ActiveOrgOwner, orgOwner } from "../proofs/org-owner.js";
import { withScimOrganizationBoundary } from "../repos/scim-organization-boundary.js";
import {
  SCIM_ROLE_ATTRIBUTE,
  finishRoleWithdrawals,
  prepareRoleWithdrawals,
  roleOf,
} from "./scim-effects.js";
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
 * grants ownership to everyone in it, so this requires an active-owner proof
 * about the exact organization (ADR 0178).
 */
export async function putGroupRoleMapping<A, O>(
  ctx: AppContext,
  actor: Named<A, ActorId>,
  org: Named<O, OrganizationId>,
  _proof: ActiveOrgOwner<A, O>,
  groupId: string,
  role: OrganizationRole,
): Promise<
  | { ok: true }
  | { ok: false; status: 403 | 404; error: "not_found" | "owner_required" }
> {
  const orgId = org.value;
  const decision = await withScimOrganizationBoundary(
    ctx,
    orgId,
    async (tx) => {
      // A proof obtained before the request body was read can be stale. The
      // organization lock orders this check with membership withdrawal.
      const owner = await orgOwner(tx.stores, actor, org, "active");
      if (!owner.ok) return owner;
      await tx.stores.scim.mappings.put(orgId, groupId, role);
      return { ok: true as const, organization: owner.organization };
    },
  );
  if (!decision.ok) return decision;
  const group = await ctx.stores.scim.groups.getById(orgId, groupId);
  if (group) {
    for (const memberId of group.memberIds) {
      await syncDerivedRole(ctx, decision.organization, memberId);
    }
  }
  return { ok: true };
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
  const existing = await ctx.stores.scim.groups.getById(
    organization.id,
    groupId,
  );
  const folded = foldGroupPatch(body, operations, existing, groupId);
  if ("error" in folded) {
    return scimError(c, 400, folded.error.detail, folded.error.scimType);
  }

  const now = ctx.clock();
  const stored = await ctx.stores.scim.groups.upsert({
    id: groupId,
    organizationId: organization.id,
    displayName: folded.displayName,
    memberIds: folded.memberIds,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });

  for (const memberId of folded.affected) {
    await syncDerivedRole(ctx, organization, memberId, c);
  }
  return scimBody(c, 200, groupResource(stored));
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

async function syncDerivedRole(
  ctx: AppContext,
  organization: Organization,
  memberId: string,
  c?: Context<{ Variables: Variables }>,
): Promise<void> {
  const correlationId =
    c?.get("correlationId") ?? `scim-role-${organization.id}`;
  const outcome = await withScimOrganizationBoundary(
    ctx,
    organization.id,
    async (tx) => {
      const current = await tx.stores.scim.users.getVersioned(
        organization.id,
        memberId,
      );
      if (!current) return undefined;
      const user = current.user;
      const derived = await derivedRoleForUser(tx, organization.id, memberId);
      const previous = roleOf(user);
      const pending = await prepareRoleWithdrawals(
        tx,
        organization,
        user,
        derived ?? "member",
        correlationId,
      );
      if (derived === previous) return { user, pending };
      const raw = { ...user.raw };
      if (derived) raw[SCIM_ROLE_ATTRIBUTE] = derived;
      else delete raw[SCIM_ROLE_ATTRIBUTE];
      const replaced = await tx.stores.scim.users.replaceIfRevision(
        organization.id,
        memberId,
        current.revision,
        { ...user, raw, updatedAt: tx.clock() },
      );
      if (!replaced) throw new Error("SCIM user changed concurrently");
      return { user: replaced.user, pending };
    },
  );
  if (!outcome) return;
  await finishRoleWithdrawals(ctx, outcome.pending);
  if (!c) return;
  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "organization.scim_role_mapped",
    outcome: "succeeded",
    organizationId: organization.id,
    correlationId: c.get("correlationId"),
    ...scimAuditActor(c),
    targetType: "scim_user",
    targetId: outcome.user.id,
    metadata: {
      action: "organization.scim_group.map_role",
      type: roleOf(outcome.user) ?? "member",
    },
  });
}
