import type { OrganizationRole } from "@opensesame/os-domain";
import { and, asc, eq } from "drizzle-orm";
import type { Database } from "./repos/postgres.js";
import { scimGroupRoleMappings, scimGroups } from "./schema/scim-groups.js";
import { normalizeGroup } from "./scim-group-values.js";
import {
  MemoryScimGroupMappingStore,
  MemoryScimGroupStore,
} from "./scim-groups-memory.js";
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
  listByOrganization(orgId: string): Promise<ScimGroupMapping[]>;
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

function createPostgresGroupTableStore(db: Database): ScimGroupStore {
  return {
    async upsert(group) {
      const row = normalizeGroup(group);
      const [inserted] = await db
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
      const rows =
        await createPostgresGroupTableStore(db).listByOrganization(orgId);
      return rows.filter((group) => group.memberIds.includes(memberId));
    },
  };
}

function createPostgresMappingStore(db: Database): ScimGroupMappingStore {
  return {
    async put(orgId, groupId, role) {
      const now = new Date();
      const [inserted] = await db
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
      if (!inserted) throw new Error("insert scim mapping returned no row");
      return {
        organizationId: inserted.organizationId,
        groupId: inserted.groupId,
        role: inserted.role,
      };
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

    async listByOrganization(orgId) {
      const rows = await db
        .select()
        .from(scimGroupRoleMappings)
        .where(eq(scimGroupRoleMappings.organizationId, orgId))
        .orderBy(asc(scimGroupRoleMappings.groupId));
      return rows.map((row) => ({
        organizationId: row.organizationId,
        groupId: row.groupId,
        role: row.role,
      }));
    },
  };
}

function createPostgresGroupStores(
  db: Database,
): Pick<ScimStores, "groups" | "mappings"> {
  return {
    groups: createPostgresGroupTableStore(db),
    mappings: createPostgresMappingStore(db),
  };
}

export function createMemoryScimStores(): ScimStores {
  return attachGroupStores(createMemoryScimUserTokenStores(), {
    groups: new MemoryScimGroupStore(),
    mappings: new MemoryScimGroupMappingStore(),
  });
}

export function createPostgresScimStores(db: Database): ScimStores {
  return attachGroupStores(
    createPostgresScimUserTokenStores(db),
    createPostgresGroupStores(db),
  );
}
