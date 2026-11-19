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
