import {
  SCIM_GROUP_ID_MAX,
  SCIM_GROUP_MEMBERS_MAX,
  ScimGroupPayloadError,
} from "./scim-group-limits.js";
import type { ScimGroupRecord } from "./scim-group-store.js";

export function groupKey(orgId: string, id: string): string {
  return `${orgId}\0${id}`;
}

export function cloneGroup(group: ScimGroupRecord): ScimGroupRecord {
  return {
    ...group,
    memberIds: [...group.memberIds],
    createdAt: new Date(group.createdAt),
    updatedAt: new Date(group.updatedAt),
  };
}

export function normalizeGroup(group: ScimGroupRecord): ScimGroupRecord {
  return {
    id: group.id,
    organizationId: group.organizationId,
    displayName: group.displayName,
    memberIds: [...new Set(group.memberIds)],
    createdAt: new Date(group.createdAt),
    updatedAt: new Date(group.updatedAt),
  };
}

/**
 * Id ceilings bound new admissions only: a group or member id that predates
 * them may stay (or be removed), so a legacy group can always be reduced.
 */
export function validateGroup(
  group: ScimGroupRecord,
  previous: readonly string[] | undefined,
): void {
  const held = new Set(previous ?? []);
  if (
    !group.id ||
    (previous === undefined && group.id.length > SCIM_GROUP_ID_MAX) ||
    group.memberIds.some(
      (id) => !id || (id.length > SCIM_GROUP_ID_MAX && !held.has(id)),
    ) ||
    (group.memberIds.length > SCIM_GROUP_MEMBERS_MAX &&
      group.memberIds.length >= (previous?.length ?? 0))
  )
    throw new ScimGroupPayloadError();
}
