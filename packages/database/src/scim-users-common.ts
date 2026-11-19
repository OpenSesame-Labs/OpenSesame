import { overlapCast } from "@opensesame/os-domain";
import { ConflictError } from "./repos/interfaces.js";
import type * as schema from "./schema/index.js";
import type { ScimUserRecord } from "./scim-store.js";

export function normalizeScimUser(user: ScimUserRecord): ScimUserRecord {
  const row: ScimUserRecord = {
    id: user.id,
    organizationId: user.organizationId,
    userName: user.userName,
    active: user.active,
    raw: structuredClone(user.raw),
    createdAt: new Date(user.createdAt),
    updatedAt: new Date(user.updatedAt),
  };
  if (user.externalId) row.externalId = user.externalId;
  if (user.displayName) row.displayName = user.displayName;
  return row;
}

export function mapScimUser(
  row: typeof schema.scimUsers.$inferSelect,
): ScimUserRecord {
  return normalizeScimUser({
    id: row.id,
    organizationId: row.organizationId,
    userName: row.userName,
    active: row.active,
    raw: overlapCast(row.raw ?? {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.externalId ? { externalId: row.externalId } : undefined),
    ...(row.displayName ? { displayName: row.displayName } : undefined),
  });
}

export function assertScimIdentity(
  orgId: string,
  id: string,
  next: ScimUserRecord,
): void {
  if (next.organizationId !== orgId || next.id !== id) {
    throw new ConflictError("scim user identity cannot be changed");
  }
}
