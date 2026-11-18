import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Database } from "./repos/postgres.js";
import { scimTokens } from "./schema/index.js";
import type { ScimTokenRecord, ScimTokenStore } from "./scim-store.js";

export function createMemoryScimTokenStore(): ScimTokenStore {
  const tokens = new Map<string, ScimTokenRecord & { hash: string }>();
  return {
    async mint(orgId, hash) {
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
        )
          return true;
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
  };
}

export function createPostgresScimTokenStore(db: Database): ScimTokenStore {
  return {
    async mint(orgId, hash) {
      const id = `scimtok_${randomUUID()}`;
      await db
        .insert(scimTokens)
        .values({ id, organizationId: orgId, tokenHash: hash });
      return { id };
    },
    async verify(orgId, hash) {
      const [row] = await db
        .select({ id: scimTokens.id })
        .from(scimTokens)
        .where(
          and(
            eq(scimTokens.organizationId, orgId),
            eq(scimTokens.tokenHash, hash),
            isNull(scimTokens.revokedAt),
          ),
        )
        .limit(1);
      return row !== undefined;
    },
    async revoke(orgId, id) {
      const rows = await db
        .update(scimTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(scimTokens.organizationId, orgId),
            eq(scimTokens.id, id),
            isNull(scimTokens.revokedAt),
          ),
        )
        .returning({ id: scimTokens.id });
      return rows.length > 0;
    },
    async list(orgId) {
      const rows = await db
        .select()
        .from(scimTokens)
        .where(eq(scimTokens.organizationId, orgId))
        .orderBy(asc(scimTokens.createdAt), asc(scimTokens.id));
      return rows.map((row) => ({
        id: row.id,
        organizationId: row.organizationId,
        createdAt: row.createdAt,
        ...(row.revokedAt ? { revokedAt: row.revokedAt } : undefined),
      }));
    },
  };
}
