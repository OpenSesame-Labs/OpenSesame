import type { OrganizationRole } from "@opensesame/os-domain";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Database } from "./repos/postgres.js";
import { scimGroups } from "./schema/scim-groups.js";
import type { ScimAdminLimits, ScimListPage } from "./scim-admin-limits.js";
import {
  ScimGroupCapacityError,
  type ScimGroupLimits,
  scimGroupLimits,
} from "./scim-group-limits.js";
import { normalizeGroup, validateGroup } from "./scim-group-values.js";
import {
  MemoryScimGroupMappingStore,
  MemoryScimGroupStore,
} from "./scim-groups-memory.js";
import { createPostgresScimMappingStore } from "./scim-mapping-store.js";
import {
  type ScimTokenRecord,
  type ScimTokenStore,
  type ScimUserRecord,
  type ScimUserStore,
  type ScimStores as ScimUserTokenStores,
  type VersionedScimUser,
  createMemoryScimStores as createMemoryScimUserTokenStores,
  createPostgresScimStores as createPostgresScimUserTokenStores,
} from "./scim-store.js";
import type { ScimUserLimits } from "./scim-user-limits.js";

export type {
  ScimTokenRecord,
  ScimTokenStore,
  ScimUserRecord,
  ScimUserStore,
  VersionedScimUser,
};

export interface ScimGroupRecord {
  id: string;
  organizationId: string;
  displayName: string;
  memberIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ScimGroupStore {
  upsert(group: ScimGroupRecord): Promise<ScimGroupRecord>;
  getById(orgId: string, id: string): Promise<ScimGroupRecord | null>;
  listByOrganization(orgId: string): Promise<ScimGroupRecord[]>;
  listByMember(orgId: string, memberId: string): Promise<ScimGroupRecord[]>;
}

export interface ScimGroupMapping {
  organizationId: string;
  groupId: string;
  role: OrganizationRole;
}

export interface ScimGroupMappingStore {
  put(
    orgId: string,
    groupId: string,
    role: OrganizationRole,
  ): Promise<ScimGroupMapping>;
  get(orgId: string, groupId: string): Promise<OrganizationRole | undefined>;
  count(orgId: string): Promise<number>;
  listByOrganization(
    orgId: string,
    page?: ScimListPage,
  ): Promise<ScimGroupMapping[]>;
  /** Removing a neutral mapping cannot confer additional authority. */
  removeIfNeutral(
    orgId: string,
    groupId: string,
  ): Promise<"deleted" | "not_found" | "mapping_not_neutral">;
}

export interface ScimStores extends ScimUserTokenStores {
  groups: ScimGroupStore;
  mappings: ScimGroupMappingStore;
}

function attachGroupStores(
  base: ScimUserTokenStores,
  extra: Pick<ScimStores, "groups" | "mappings">,
): ScimStores {
  return { ...base, ...extra };
}

function mapGroup(row: typeof scimGroups.$inferSelect): ScimGroupRecord {
  return normalizeGroup({
    id: row.id,
    organizationId: row.organizationId,
    displayName: row.displayName,
    memberIds: Array.isArray(row.memberIds) ? row.memberIds : [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function createPostgresGroupTableStore(
  db: Database,
  limits = scimGroupLimits(),
): ScimGroupStore {
  return {
    async upsert(group) {
      const row = normalizeGroup(group);
      return db.transaction(
        async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext('OpenSesame:ScimGroups'), 0)`,
          );
          const [existing] = await tx
            .select({ id: scimGroups.id, memberIds: scimGroups.memberIds })
            .from(scimGroups)
            .where(
              and(
                eq(scimGroups.organizationId, row.organizationId),
                eq(scimGroups.id, row.id),
              ),
            )
            .limit(1);
          validateGroup(row, existing?.memberIds);
          if (!existing) {
            const [usage] = await tx
              .select({
                deployment: sql<number>`count(*)::integer`,
                organization: sql<number>`count(*) filter (where ${scimGroups.organizationId} = ${row.organizationId})::integer`,
              })
              .from(scimGroups);
            if (
              !usage ||
              usage.organization >= limits.perOrganization ||
              usage.deployment >= limits.perDeployment
            )
              throw new ScimGroupCapacityError();
          }
          const [inserted] = await tx
            .insert(scimGroups)
            .values({
              id: row.id,
              organizationId: row.organizationId,
              displayName: row.displayName,
              memberIds: row.memberIds,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
            })
            .onConflictDoUpdate({
              target: [scimGroups.organizationId, scimGroups.id],
              set: {
                displayName: row.displayName,
                memberIds: row.memberIds,
                updatedAt: row.updatedAt,
              },
            })
            .returning();
          if (!inserted) throw new Error("insert scim group returned no row");
          return mapGroup(inserted);
        },
        { isolationLevel: "read committed" },
      );
    },

    async getById(orgId, id) {
      const [row] = await db
        .select()
        .from(scimGroups)
        .where(and(eq(scimGroups.organizationId, orgId), eq(scimGroups.id, id)))
        .limit(1);
      return row ? mapGroup(row) : null;
    },

    async listByOrganization(orgId) {
      const rows = await db
        .select()
        .from(scimGroups)
        .where(eq(scimGroups.organizationId, orgId))
        .orderBy(asc(scimGroups.createdAt));
      return rows.map(mapGroup);
    },

    async listByMember(orgId, memberId) {
      const rows = await db
        .select()
        .from(scimGroups)
        .where(
          and(
            eq(scimGroups.organizationId, orgId),
            sql`${scimGroups.memberIds} ? ${memberId}`,
          ),
        )
        .orderBy(asc(scimGroups.createdAt), asc(scimGroups.id));
      return rows.map(mapGroup);
    },
  };
}

export function createMemoryScimStores(
  limits?: Partial<ScimUserLimits>,
  groupLimits?: Partial<ScimGroupLimits>,
  adminLimits?: Partial<ScimAdminLimits>,
): ScimStores {
  return attachGroupStores(
    createMemoryScimUserTokenStores(limits, adminLimits),
    {
      groups: new MemoryScimGroupStore(groupLimits),
      mappings: new MemoryScimGroupMappingStore(adminLimits),
    },
  );
}

export function createPostgresScimStores(
  db: Database,
  limits?: Partial<ScimUserLimits>,
  groupLimits?: Partial<ScimGroupLimits>,
  adminLimits?: Partial<ScimAdminLimits>,
): ScimStores {
  return attachGroupStores(
    createPostgresScimUserTokenStores(db, limits, adminLimits),
    {
      groups: createPostgresGroupTableStore(db, scimGroupLimits(groupLimits)),
      mappings: createPostgresScimMappingStore(db, adminLimits),
    },
  );
}
