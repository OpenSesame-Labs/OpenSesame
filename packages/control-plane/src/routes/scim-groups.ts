import type { Named } from "@gdp-ts/core";
import { appendAuditEvent } from "@opensesame/audit";
import {
  SCIM_GROUP_ID_MAX,
  ScimGroupCapacityError,
  ScimGroupPayloadError,
  type ScimGroupRecord,
} from "@opensesame/database";
import type {
  JsonObject,
  Organization,
  OrganizationRole,
} from "@opensesame/os-domain";
import type { Context } from "hono";
import type { AppContext } from "../context.js";
import type { ActorId, OrganizationId } from "../lib/ids.js";
import type { Variables } from "../middleware/context.js";
import { type ActiveOrgOwner, activeOrgOwner } from "../proofs/org-owner.js";
import { withScimOrganizationBoundary } from "../repos/scim-organization-boundary.js";
import {
  type PreparedWithdrawal,
  finishOrganizationWithdrawal,
} from "../services/organization-withdrawal.js";
import { SCIM_ROLE_ATTRIBUTE, applyRole, roleOf } from "./scim-effects.js";
import { foldGroupPatch } from "./scim-group-patch.js";
import { memberIds, parseMemberSelector } from "./scim-member-selector.js";
import {
  readScimJsonBody,
  scimAuditActor,
  scimBody,
  scimError,
  scimPatchOperations,
} from "./scim-protocol.js";
import { consumeScimMutation } from "./scim-rate-limit.js";

const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";

const ROLE_RANK = {
  member: 1,
  admin: 2,
  owner: 3,
} as const;

const RATE_LIMITED = "Provisioning rate limit reached.";

type GroupRefusal = {
  refused: { status: 400 | 409 | 429; detail: string; scimType?: string };
  retry?: true;
};
type GroupPatchOutcome =
  | GroupRefusal
  | {
      stored: ScimGroupRecord;
      affected: string[];
      prepared: PreparedWithdrawal[];
    };

function refusal(
  status: 400 | 409,
  detail: string,
  scimType?: string,
): GroupRefusal {
  // Two literals rather than a conditional spread: omitting `scimType` and
  // carrying `scimType: undefined` are different answers to a SCIM client.
  if (!scimType) return { refused: { status, detail } };
  return { refused: { status, detail, scimType } };
}

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
      const owner = await activeOrgOwner(tx.stores, actor, org);
      if (!owner.ok) return owner;
      await tx.stores.scim.mappings.put(orgId, groupId, role);
      const group = await tx.stores.scim.groups.getById(orgId, groupId);
      if (!group) return { ok: true as const, prepared: [] };
      const pending: PreparedWithdrawal[] = [];
      for (const memberId of group.memberIds) {
        pending.push(
          ...(await syncDerivedRole(
            tx,
            owner.organization,
            memberId,
            `scim-role-${groupId}`,
          )),
        );
      }
      return { ok: true as const, prepared: pending };
    },
  );
  if (!decision.ok) return decision;
  await finishRoleChanges(ctx, decision.prepared);
  return { ok: true };
}

/** Removing only neutral mappings cannot confer new authority. */
export function removeNeutralGroupRoleMapping<A, O>(
  ctx: AppContext,
  org: Named<O, OrganizationId>,
  _proof: ActiveOrgOwner<A, O>,
  groupId: string,
) {
  return ctx.stores.scim.mappings.removeIfNeutral(org.value, groupId);
}

export async function patchScimGroup(
  c: Context<{ Variables: Variables }>,
  session: ScimSession,
): Promise<Response> {
  const { ctx, organization } = session;
  const body = await readScimJsonBody(c);
  if (!body) return scimError(c, 400, "Body is not a SCIM PatchOp.");
  const groupId = decodeURIComponent(c.req.param("groupId") ?? "");
  if (!groupId) return scimError(c, 400, "Invalid group id.", "invalidValue");

  const operations = scimPatchOperations(body);
  const outcome = await withScimOrganizationBoundary(
    ctx,
    organization.id,
    async (tx): Promise<GroupPatchOutcome> => {
      const existing = await tx.stores.scim.groups.getById(
        organization.id,
        groupId,
      );
      // The id ceiling bounds new groups only. A group that predates it must
      // stay reducible, or the privileges its mapping confers could not be
      // withdrawn.
      if (!existing && groupId.length > SCIM_GROUP_ID_MAX)
        return refusal(400, "Invalid group id.", "invalidValue");
      const folded = foldGroupPatch(body, operations, existing, groupId);
      if ("error" in folded)
        return refusal(400, folded.error.detail, folded.error.scimType);
      // One unit was spent before parsing. Charge each additional target
      // before a group update can trigger member reconciliation and audits.
      if (
        folded.affected.length > 1 &&
        !(await consumeScimMutation(
          ctx,
          organization.id,
          undefined,
          folded.affected.length - 1,
        ))
      )
        return { refused: { status: 429, detail: RATE_LIMITED }, retry: true };
      const now = ctx.clock();
      let stored: ScimGroupRecord;
      try {
        stored = await tx.stores.scim.groups.upsert({
          id: groupId,
          organizationId: organization.id,
          displayName: folded.displayName,
          memberIds: folded.memberIds,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        });
      } catch (error) {
        if (error instanceof ScimGroupCapacityError)
          return refusal(409, "Provisioned group capacity reached.");
        if (error instanceof ScimGroupPayloadError)
          return refusal(400, "Group exceeds the storage limit.", "tooMany");
        throw error;
      }
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
  if ("refused" in outcome) {
    if ("retry" in outcome) c.header("Retry-After", "60");
    const { status, detail, scimType } = outcome.refused;
    return scimError(c, status, detail, scimType);
  }
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
