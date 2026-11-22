import { overlapCast } from "@opensesame/os-domain";
import { and, asc, count, eq } from "drizzle-orm";
import {
  type ScimUserRecord,
  type ScimUserStore,
  createMemoryScimUserStore,
  createPostgresScimWithinLimit,
  mapScimUser,
  normalizeScimUser,
} from "./capacity-admission.js";
import { isUniqueViolation } from "./client-origin-store.js";
import { ConflictError } from "./repos/interfaces.js";
import type { Database } from "./repos/postgres.js";
import * as schema from "./schema/index.js";
import type { ScimAdminLimits, ScimListPage } from "./scim-admin-limits.js";
import {
  createMemoryScimTokenStore,
  createPostgresScimTokenStore,
} from "./scim-token-store.js";
import {
  ScimUserCapacityError,
  type ScimUserLimits,
  scimUserLimits,
} from "./scim-user-limits.js";

/**
 * A SCIM 2.0 provisioned user (ADR 0056).
 *
 * No principal is minted at provision time: the row is the organization's
 * answer to "may this subject join?" when a sign-in eventually arrives.
 * `raw` keeps the attributes the IdP sent — SCIM's leniency norm is to accept
 * and echo what we do not model.
 */
export type { ScimUserRecord, ScimUserStore } from "./capacity-admission.js";

export interface ScimTokenRecord {
  id: string;
  organizationId: string;
  createdAt: Date;
  revokedAt?: Date;
}

/**
 * Org-scoped provisioning tokens. Only the hash is ever stored — the plaintext
 * `sct_` value exists exactly once, in the mint response.
 */
export interface ScimTokenStore {
  mint(orgId: string, hash: string): Promise<{ id: string }>;
  /** True when a live (unrevoked) token of this org has this hash. */
  verify(orgId: string, hash: string): Promise<boolean>;
  revoke(orgId: string, id: string): Promise<boolean>;
  /** Owner surface: token ids and lifecycle stamps, never hashes. */
  list(orgId: string, page?: ScimListPage): Promise<ScimTokenRecord[]>;
  count(orgId: string): Promise<number>;
  /** Remove retained metadata only after its credential has been revoked. */
  purgeRevoked(orgId: string, id: string): Promise<boolean>;
}

export interface ScimStores {
  users: ScimUserStore;
  tokens: ScimTokenStore;
}

/**
 * `options` lowers the hard per-tenant and deployment-wide user ceilings
 * (`scim-user-limits.ts`) for smaller deployments and tests.
 */
export function createMemoryScimStores(
  options?: Partial<ScimUserLimits>,
  adminLimits?: Partial<ScimAdminLimits>,
): ScimStores {
  return {
    users: createMemoryScimUserStore(options),
    tokens: createMemoryScimTokenStore(adminLimits),
  };
}

export function createPostgresScimStores(
  db: Database,
  options?: Partial<ScimUserLimits>,
  adminLimits?: Partial<ScimAdminLimits>,
): ScimStores {
  const limits = scimUserLimits(options);
  const admit = (user: ScimUserRecord, limit: number) =>
    createPostgresScimWithinLimit(
      db,
      user,
      Math.min(limit, limits.perOrganization),
      limits.perDeployment,
    );
  return {
    users: {
      async create(user) {
        const created = await admit(user, limits.perOrganization);
        if (!created) throw new ScimUserCapacityError();
        return created;
      },

      async createWithinLimit(user, limit) {
        return admit(user, limit);
      },

      async getById(orgId, id) {
        const [row] = await db
          .select()
          .from(schema.scimUsers)
          .where(
            and(
              eq(schema.scimUsers.organizationId, orgId),
              eq(schema.scimUsers.id, id),
            ),
          )
          .limit(1);
        return row ? mapScimUser(row) : null;
      },

      async findByUserName(orgId, userName) {
        const [row] = await db
          .select()
          .from(schema.scimUsers)
          .where(
            and(
              eq(schema.scimUsers.organizationId, orgId),
              eq(schema.scimUsers.userName, userName),
            ),
          )
          .limit(1);
        return row ? mapScimUser(row) : null;
      },

      async findBySubject(orgId, subject) {
        const [byExternalId] = await db
          .select()
          .from(schema.scimUsers)
          .where(
            and(
              eq(schema.scimUsers.organizationId, orgId),
              eq(schema.scimUsers.externalId, subject),
            ),
          )
          .orderBy(asc(schema.scimUsers.createdAt), asc(schema.scimUsers.id))
          .limit(1);
        if (byExternalId) return mapScimUser(byExternalId);
        const [byUserName] = await db
          .select()
          .from(schema.scimUsers)
          .where(
            and(
              eq(schema.scimUsers.organizationId, orgId),
              eq(schema.scimUsers.userName, subject),
            ),
          )
          .limit(1);
        return byUserName ? mapScimUser(byUserName) : null;
      },

      async update(user) {
        const row = normalizeScimUser(user);
        try {
          const [updated] = await db
            .update(schema.scimUsers)
            .set({
              externalId: row.externalId ?? null,
              userName: row.userName,
              active: row.active,
              displayName: row.displayName ?? null,
              raw: row.raw,
              updatedAt: row.updatedAt,
            })
            .where(
              and(
                eq(schema.scimUsers.organizationId, row.organizationId),
                eq(schema.scimUsers.id, row.id),
              ),
            )
            .returning();
          if (!updated)
            throw new ConflictError(`scim user not found: ${row.id}`);
          return mapScimUser(updated);
        } catch (error) {
          if (isUniqueViolation(overlapCast(error))) {
            throw new ConflictError(
              `scim user already exists: ${row.userName}`,
            );
          }
          throw error;
        }
      },

      async countByOrganization(orgId) {
        const [row] = await db
          .select({ value: count() })
          .from(schema.scimUsers)
          .where(eq(schema.scimUsers.organizationId, orgId));
        return Number(row?.value ?? 0);
      },

      async listByOrganization(orgId, page) {
        const base = db
          .select()
          .from(schema.scimUsers)
          .where(eq(schema.scimUsers.organizationId, orgId))
          .orderBy(asc(schema.scimUsers.createdAt), asc(schema.scimUsers.id));
        const rows = page
          ? await base.limit(page.limit).offset(page.offset)
          : await base;
        return rows.map(mapScimUser);
      },
    },

    tokens: createPostgresScimTokenStore(db, adminLimits),
  };
}
