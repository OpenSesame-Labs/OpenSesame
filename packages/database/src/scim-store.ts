import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { and, asc, eq, sql } from "drizzle-orm";
import { isUniqueViolation } from "./client-origin-store.js";
import { ConflictError } from "./repos/interfaces.js";
import type { Database } from "./repos/postgres.js";
import * as schema from "./schema/index.js";
import {
  createMemoryScimTokenStore,
  createPostgresScimTokenStore,
} from "./scim-token-store.js";
import {
  ScimUserCapacityError,
  type ScimUserLimits,
  scimUserLimits,
  validateScimPage,
  validateScimRaw,
} from "./scim-user-limits.js";

/**
 * A SCIM 2.0 provisioned user (ADR 0056).
 *
 * No principal is minted at provision time: the row is the organization's
 * answer to "may this subject join?" when a sign-in eventually arrives.
 * `raw` keeps the attributes the IdP sent — SCIM's leniency norm is to accept
 * and echo what we do not model.
 */
export interface ScimUserRecord {
  id: string;
  organizationId: string;
  externalId?: string;
  userName: string;
  active: boolean;
  displayName?: string;
  raw: JsonObject;
  createdAt: Date;
  updatedAt: Date;
}

export interface ScimTokenRecord {
  id: string;
  organizationId: string;
  createdAt: Date;
  revokedAt?: Date;
}

export interface ScimUserPage {
  resources: ScimUserRecord[];
  totalResults: number;
}

export interface ScimUserPageRequest {
  startIndex: number;
  count: number;
}

export interface ScimUserStore {
  create(user: ScimUserRecord): Promise<ScimUserRecord>;
  getById(orgId: string, id: string): Promise<ScimUserRecord | null>;
  findByUserName(
    orgId: string,
    userName: string,
  ): Promise<ScimUserRecord | null>;
  /**
   * The row an asserted sign-in subject provisions to: `externalId` first
   * (the IdP's own stable id), `userName` only as the fallback for directories
   * that send none.
   */
  findBySubject(orgId: string, subject: string): Promise<ScimUserRecord | null>;
  update(user: ScimUserRecord): Promise<ScimUserRecord>;
  listByOrganization(
    orgId: string,
    page: ScimUserPageRequest,
  ): Promise<ScimUserPage>;
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
  list(orgId: string): Promise<ScimTokenRecord[]>;
}

export interface ScimStores {
  users: ScimUserStore;
  tokens: ScimTokenStore;
}

function cloneScimUser(user: ScimUserRecord): ScimUserRecord {
  return { ...user, raw: structuredClone(user.raw) };
}

function normalizeScimUser(user: ScimUserRecord): ScimUserRecord {
  const row: ScimUserRecord = {
    id: user.id,
    organizationId: user.organizationId,
    userName: user.userName,
    active: user.active,
    raw: structuredClone(user.raw),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
  if (user.externalId) row.externalId = user.externalId;
  if (user.displayName) row.displayName = user.displayName;
  return row;
}

function mapScimUser(
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

export function createMemoryScimStores(
  options?: Partial<ScimUserLimits>,
): ScimStores {
  const limits = scimUserLimits(options);
  const users = new Map<string, ScimUserRecord>();

  const ofOrg = (orgId: string) =>
    [...users.values()].filter((user) => user.organizationId === orgId);

  return {
    users: {
      async create(user) {
        validateScimRaw(user.raw);
        const row = normalizeScimUser(user);
        const scoped = ofOrg(row.organizationId);
        const clash = scoped.find(
          (existing) => existing.userName === row.userName,
        );
        if (clash || users.has(row.id)) {
          throw new ConflictError(`scim user already exists: ${row.userName}`);
        }
        if (
          scoped.length >= limits.perOrganization ||
          users.size >= limits.perDeployment
        )
          throw new ScimUserCapacityError();
        users.set(row.id, row);
        return cloneScimUser(row);
      },

      async getById(orgId, id) {
        const row = users.get(id);
        return row && row.organizationId === orgId ? cloneScimUser(row) : null;
      },

      async findByUserName(orgId, userName) {
        const row = ofOrg(orgId).find((user) => user.userName === userName);
        return row ? cloneScimUser(row) : null;
      },

      async findBySubject(orgId, subject) {
        const scoped = ofOrg(orgId);
        const byExternalId = scoped.find((user) => user.externalId === subject);
        if (byExternalId) return cloneScimUser(byExternalId);
        const byUserName = scoped.find((user) => user.userName === subject);
        return byUserName ? cloneScimUser(byUserName) : null;
      },

      async update(user) {
        const row = normalizeScimUser(user);
        if (users.get(row.id)?.organizationId !== row.organizationId) {
          throw new ConflictError(`scim user not found: ${row.id}`);
        }
        users.set(row.id, row);
        return cloneScimUser(row);
      },

      async listByOrganization(orgId, page) {
        validateScimPage(page);
        const rows = ofOrg(orgId).sort(
          (a, b) =>
            a.createdAt.getTime() - b.createdAt.getTime() ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        );
        return {
          totalResults: rows.length,
          resources: rows
            .slice(page.startIndex - 1, page.startIndex - 1 + page.count)
            .map(cloneScimUser),
        };
      },
    },

    tokens: createMemoryScimTokenStore(),
  };
}

export function createPostgresScimStores(
  db: Database,
  options?: Partial<ScimUserLimits>,
): ScimStores {
  const limits = scimUserLimits(options);
  return {
    users: {
      async create(user) {
        validateScimRaw(user.raw);
        const row = normalizeScimUser(user);
        try {
          return await db.transaction(
            async (tx) => {
              // One deployment-wide lock makes both counts and the insert atomic
              // across replicas, including the first user of an organization.
              await tx.execute(
                sql`SELECT pg_advisory_xact_lock(hashtext('OpenSesame:ScimUsers'), 0)`,
              );
              const [usage] = await tx
                .select({
                  deployment: sql<number>`count(*)::integer`,
                  organization: sql<number>`count(*) filter (where ${schema.scimUsers.organizationId} = ${row.organizationId})::integer`,
                })
                .from(schema.scimUsers);
              if (
                !usage ||
                usage.organization >= limits.perOrganization ||
                usage.deployment >= limits.perDeployment
              )
                throw new ScimUserCapacityError();
              const [inserted] = await tx
                .insert(schema.scimUsers)
                .values({
                  id: row.id,
                  organizationId: row.organizationId,
                  externalId: row.externalId ?? null,
                  userName: row.userName,
                  active: row.active,
                  displayName: row.displayName ?? null,
                  raw: row.raw,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                })
                .returning();
              if (!inserted)
                throw new Error("insert scim user returned no row");
              return mapScimUser(inserted);
            },
            { isolationLevel: "read committed" },
          );
        } catch (error) {
          if (isUniqueViolation(overlapCast(error))) {
            throw new ConflictError(
              `scim user already exists: ${row.userName}`,
            );
          }
          throw error;
        }
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

      async listByOrganization(orgId, page) {
        validateScimPage(page);
        const [usage] = await db
          .select({ total: sql<number>`count(*)::integer` })
          .from(schema.scimUsers)
          .where(eq(schema.scimUsers.organizationId, orgId));
        const totalResults = usage?.total ?? 0;
        if (page.count === 0 || page.startIndex > totalResults)
          return { resources: [], totalResults };
        const rows = await db
          .select()
          .from(schema.scimUsers)
          .where(eq(schema.scimUsers.organizationId, orgId))
          .orderBy(asc(schema.scimUsers.createdAt), asc(schema.scimUsers.id))
          .limit(page.count)
          .offset(page.startIndex - 1);
        return { resources: rows.map(mapScimUser), totalResults };
      },
    },

    tokens: createPostgresScimTokenStore(db),
  };
}
