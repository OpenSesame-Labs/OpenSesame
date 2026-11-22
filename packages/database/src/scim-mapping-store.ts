import type { OrganizationRole } from "@opensesame/os-domain";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Database } from "./repos/postgres.js";
import { scimGroupRoleMappings } from "./schema/scim-groups.js";
import {
  ScimAdminCapacityError,
  type ScimAdminLimits,
  scimAdminLimits,
  scimAdminPage,
} from "./scim-admin-limits.js";
import { scimMappingAdmissible } from "./scim-group-limits.js";
import type {
  ScimGroupMapping,
  ScimGroupMappingStore,
} from "./scim-group-store.js";

function key(orgId: string, groupId: string): string {
  return `${orgId}\0${groupId}`;
}
/** New or raised over-long mappings are refused; reductions stay possible. */
function validateId(
  groupId: string,
  role: OrganizationRole,
  existing: OrganizationRole | undefined,
): void {
  if (!scimMappingAdmissible(groupId, role, existing))
    throw new Error("Invalid SCIM group id");
}

export function createMemoryScimMappingStore(
  options?: Partial<ScimAdminLimits>,
): ScimGroupMappingStore {
  const limits = scimAdminLimits(options);
  const mappings = new Map<string, ScimGroupMapping>();
  const ofOrg = (orgId: string) =>
    [...mappings.values()].filter((row) => row.organizationId === orgId);
  return {
    async put(orgId: string, groupId: string, role: OrganizationRole) {
      const id = key(orgId, groupId);
      validateId(groupId, role, mappings.get(id)?.role);
      if (
        !mappings.has(id) &&
        (ofOrg(orgId).length >= limits.mappingsPerOrganization ||
          mappings.size >= limits.mappingsPerDeployment)
      )
        throw new ScimAdminCapacityError();
      const row = { organizationId: orgId, groupId, role };
      mappings.set(id, row);
      return { ...row };
    },
    async get(orgId, groupId) {
      return mappings.get(key(orgId, groupId))?.role;
    },
    async count(orgId) {
      return ofOrg(orgId).length;
    },
    async listByOrganization(orgId, input) {
      const page = scimAdminPage(input);
      return ofOrg(orgId)
        .sort((a, b) =>
          a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : 0,
        )
        .slice(page.offset, page.offset + page.limit)
        .map((row) => ({ ...row }));
    },
    async removeIfNeutral(orgId, groupId) {
      const id = key(orgId, groupId);
      const row = mappings.get(id);
      if (!row) return "not_found";
      if (row.role !== "member") return "mapping_not_neutral";
      mappings.delete(id);
      return "deleted";
    },
  };
}

async function putPostgresMapping(
  db: Database,
  limits: ScimAdminLimits,
  orgId: string,
  groupId: string,
  role: OrganizationRole,
): Promise<ScimGroupMapping> {
  if (!groupId) throw new Error("Invalid SCIM group id");
  return db.transaction(
    async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('OpenSesame:ScimMappings'), 0)`,
      );
      const condition = and(
        eq(scimGroupRoleMappings.organizationId, orgId),
        eq(scimGroupRoleMappings.groupId, groupId),
      );
      const [existing] = await tx
        .select({ role: scimGroupRoleMappings.role })
        .from(scimGroupRoleMappings)
        .where(condition)
        .limit(1);
      validateId(groupId, role, existing?.role);
      if (!existing) {
        const [usage] = await tx
          .select({
            deployment: sql<number>`count(*)::integer`,
            organization: sql<number>`count(*) filter (where ${scimGroupRoleMappings.organizationId} = ${orgId})::integer`,
          })
          .from(scimGroupRoleMappings);
        if (
          !usage ||
          usage.organization >= limits.mappingsPerOrganization ||
          usage.deployment >= limits.mappingsPerDeployment
        )
          throw new ScimAdminCapacityError();
      }
      const now = new Date();
      const [row] = await tx
        .insert(scimGroupRoleMappings)
        .values({
          organizationId: orgId,
          groupId,
          role,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            scimGroupRoleMappings.organizationId,
            scimGroupRoleMappings.groupId,
          ],
          set: { role, updatedAt: now },
        })
        .returning();
      if (!row) throw new Error("insert scim mapping returned no row");
      return {
        organizationId: row.organizationId,
        groupId: row.groupId,
        role: row.role,
      };
    },
    { isolationLevel: "read committed" },
  );
}

export function createPostgresScimMappingStore(
  db: Database,
  options?: Partial<ScimAdminLimits>,
): ScimGroupMappingStore {
  const limits = scimAdminLimits(options);
  return {
    async put(orgId, groupId, role) {
      return putPostgresMapping(db, limits, orgId, groupId, role);
    },
    async get(orgId, groupId) {
      const [row] = await db
        .select()
        .from(scimGroupRoleMappings)
        .where(
          and(
            eq(scimGroupRoleMappings.organizationId, orgId),
            eq(scimGroupRoleMappings.groupId, groupId),
          ),
        )
        .limit(1);
      return row?.role;
    },
    async count(orgId) {
      const [row] = await db
        .select({ total: sql<number>`count(*)::integer` })
        .from(scimGroupRoleMappings)
        .where(eq(scimGroupRoleMappings.organizationId, orgId));
      return row?.total ?? 0;
    },
    async listByOrganization(orgId, input) {
      const page = scimAdminPage(input);
      if (page.limit === 0 || page.offset >= 2_147_483_647) return [];
      const rows = await db
        .select()
        .from(scimGroupRoleMappings)
        .where(eq(scimGroupRoleMappings.organizationId, orgId))
        .orderBy(asc(scimGroupRoleMappings.groupId))
        .limit(page.limit)
        .offset(page.offset);
      return rows.map((row) => ({
        organizationId: row.organizationId,
        groupId: row.groupId,
        role: row.role,
      }));
    },
    async removeIfNeutral(orgId, groupId) {
      return db.transaction(
        async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext('OpenSesame:ScimMappings'), 0)`,
          );
          const mappingCondition = and(
            eq(scimGroupRoleMappings.organizationId, orgId),
            eq(scimGroupRoleMappings.groupId, groupId),
          );
          const [mapping] = await tx
            .select({ role: scimGroupRoleMappings.role })
            .from(scimGroupRoleMappings)
            .where(mappingCondition)
            .limit(1);
          if (!mapping) return "not_found";
          if (mapping.role !== "member") return "mapping_not_neutral";
          const removed = await tx
            .delete(scimGroupRoleMappings)
            .where(mappingCondition)
            .returning({ id: scimGroupRoleMappings.groupId });
          return removed.length ? "deleted" : "not_found";
        },
        { isolationLevel: "read committed" },
      );
    },
  };
}
