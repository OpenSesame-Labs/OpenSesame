import { randomUUID } from "node:crypto";
import { overlapCast } from "@opensesame/os-domain";
import { and, asc, count, eq, isNull } from "drizzle-orm";
import {
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
  list(orgId: string): Promise<ScimTokenRecord[]>;
}

export interface ScimStores {
  users: ScimUserStore;
  tokens: ScimTokenStore;
}

function mapScimToken(
  row: typeof schema.scimTokens.$inferSelect,
): ScimTokenRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    createdAt: row.createdAt,
    ...(row.revokedAt ? { revokedAt: row.revokedAt } : undefined),
  };
}

export function createMemoryScimStores(): ScimStores {
  const tokens = new Map<string, ScimTokenRecord & { hash: string }>();
  return {
    users: createMemoryScimUserStore(),
    tokens: {
      async mint(orgId, hash) {
        // Row id, not the token: the plaintext `sct_` value never lands here.
        const id = `scimtok_${randomUUID()}`;
        tokens.set(id, {
          id,
          organizationId: orgId,
          createdAt: new Date(),
          hash,
        });
        return { id };
      },

      async verify(orgId, hash) {
        for (const row of tokens.values()) {
          if (
            row.organizationId === orgId &&
            row.hash === hash &&
            row.revokedAt === undefined
          ) {
            return true;
          }
        }
        return false;
      },

      async revoke(orgId, id) {
        const row = tokens.get(id);
        if (!row || row.organizationId !== orgId || row.revokedAt) return false;
        tokens.set(id, { ...row, revokedAt: new Date() });
        return true;
      },

      async list(orgId) {
        return [...tokens.values()]
          .filter((row) => row.organizationId === orgId)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map(({ hash: _hash, ...record }) => ({ ...record }));
      },
    },
  };
}

export function createPostgresScimStores(db: Database): ScimStores {
  return {
    users: {
      async create(user) {
        const row = normalizeScimUser(user);
        try {
          const [inserted] = await db
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
          if (!inserted) throw new Error("insert scim user returned no row");
          return mapScimUser(inserted);
        } catch (error) {
          if (isUniqueViolation(overlapCast(error))) {
            throw new ConflictError(
              `scim user already exists: ${row.userName}`,
            );
          }
          throw error;
        }
      },

      async createWithinLimit(user, limit) {
        return createPostgresScimWithinLimit(db, user, limit);
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

    tokens: {
      async mint(orgId, hash) {
        // Row id, not the token: the plaintext `sct_` value never lands here.
        const id = `scimtok_${randomUUID()}`;
        await db.insert(schema.scimTokens).values({
          id,
          organizationId: orgId,
          tokenHash: hash,
        });
        return { id };
      },

      async verify(orgId, hash) {
        const [row] = await db
          .select({ id: schema.scimTokens.id })
          .from(schema.scimTokens)
          .where(
            and(
              eq(schema.scimTokens.organizationId, orgId),
              eq(schema.scimTokens.tokenHash, hash),
              isNull(schema.scimTokens.revokedAt),
            ),
          )
          .limit(1);
        return row !== undefined;
      },

      async revoke(orgId, id) {
        const rows = await db
          .update(schema.scimTokens)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(schema.scimTokens.organizationId, orgId),
              eq(schema.scimTokens.id, id),
              isNull(schema.scimTokens.revokedAt),
            ),
          )
          .returning({ id: schema.scimTokens.id });
        return rows.length > 0;
      },

      async list(orgId) {
        const rows = await db
          .select()
          .from(schema.scimTokens)
          .where(eq(schema.scimTokens.organizationId, orgId))
          .orderBy(asc(schema.scimTokens.createdAt), asc(schema.scimTokens.id));
        return rows.map(mapScimToken);
      },
    },
  };
}
