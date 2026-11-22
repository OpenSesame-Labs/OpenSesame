import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Database } from "./repos/postgres.js";
import { scimTokens } from "./schema/index.js";
import {
  ScimAdminCapacityError,
  type ScimAdminLimits,
  scimAdminLimits,
  scimAdminPage,
} from "./scim-admin-limits.js";
import type { ScimTokenRecord, ScimTokenStore } from "./scim-store.js";

type StoredToken = ScimTokenRecord & { hash: string };
const MAX_PRUNE = 1_000;

function orderTokens(a: ScimTokenRecord, b: ScimTokenRecord): number {
  return (
    a.createdAt.getTime() - b.createdAt.getTime() ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

export function createMemoryScimTokenStore(
  options?: Partial<ScimAdminLimits>,
): ScimTokenStore {
  const limits = scimAdminLimits(options);
  const tokens = new Map<string, StoredToken>();
  return {
    async mint(orgId, hash) {
      // Row id, not the token: the plaintext `sct_` value never lands here.
      const all = [...tokens.values()];
      const revoked = all
        .filter((row) => row.revokedAt !== undefined)
        .sort(
          (a, b) =>
            (a.revokedAt?.getTime() ?? 0) - (b.revokedAt?.getTime() ?? 0) ||
            orderTokens(a, b),
        );
      const chosen = new Set<string>();
      const choose = (needed: number, candidates: StoredToken[]) => {
        if (needed > MAX_PRUNE) throw new ScimAdminCapacityError();
        for (const row of candidates) {
          if (chosen.size >= needed) break;
          chosen.add(row.id);
        }
        if (chosen.size < needed) throw new ScimAdminCapacityError();
      };
      const localNeeded = Math.max(
        0,
        all.filter((row) => row.organizationId === orgId).length -
          limits.tokensPerOrganization +
          1,
      );
      choose(
        localNeeded,
        revoked.filter((row) => row.organizationId === orgId),
      );
      const totalNeeded = Math.max(
        localNeeded,
        all.length - limits.tokensPerDeployment + 1,
      );
      choose(totalNeeded, revoked);
      for (const id of chosen) tokens.delete(id);
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
    async purgeRevoked(orgId, id) {
      const row = tokens.get(id);
      if (!row || row.organizationId !== orgId || !row.revokedAt) return false;
      return tokens.delete(id);
    },
    async count(orgId) {
      return [...tokens.values()].filter((row) => row.organizationId === orgId)
        .length;
    },
    async list(orgId, input) {
      const page = scimAdminPage(input);
      return [...tokens.values()]
        .filter((row) => row.organizationId === orgId)
        .sort(orderTokens)
        .slice(page.offset, page.offset + page.limit)
        .map(({ hash: _hash, ...record }) => ({ ...record }));
    },
  };
}

async function mintPostgresToken(
  db: Database,
  limits: ScimAdminLimits,
  orgId: string,
  hash: string,
): Promise<{ id: string }> {
  return db.transaction(
    async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('OpenSesame:ScimTokens'), 0)`,
      );
      const [usage] = await tx
        .select({
          deployment: sql<number>`count(*)::integer`,
          organization: sql<number>`count(*) filter (where ${scimTokens.organizationId} = ${orgId})::integer`,
        })
        .from(scimTokens);
      if (!usage) throw new ScimAdminCapacityError();
      const prune = async (needed: number, tenant?: string) => {
        if (needed <= 0) return;
        if (needed > MAX_PRUNE) throw new ScimAdminCapacityError();
        const condition =
          tenant === undefined
            ? isNotNull(scimTokens.revokedAt)
            : and(
                eq(scimTokens.organizationId, tenant),
                isNotNull(scimTokens.revokedAt),
              );
        const candidates = await tx
          .select({ id: scimTokens.id })
          .from(scimTokens)
          .where(condition)
          .orderBy(asc(scimTokens.revokedAt), asc(scimTokens.id))
          .limit(needed);
        if (candidates.length !== needed) throw new ScimAdminCapacityError();
        await tx.delete(scimTokens).where(
          inArray(
            scimTokens.id,
            candidates.map((row) => row.id),
          ),
        );
      };
      const localNeeded = Math.max(
        0,
        usage.organization - limits.tokensPerOrganization + 1,
      );
      await prune(localNeeded, orgId);
      await prune(
        Math.max(
          0,
          usage.deployment - localNeeded - limits.tokensPerDeployment + 1,
        ),
      );
      const id = `scimtok_${randomUUID()}`;
      await tx
        .insert(scimTokens)
        .values({ id, organizationId: orgId, tokenHash: hash });
      return { id };
    },
    { isolationLevel: "read committed" },
  );
}

export function createPostgresScimTokenStore(
  db: Database,
  options?: Partial<ScimAdminLimits>,
): ScimTokenStore {
  const limits = scimAdminLimits(options);
  return {
    async mint(orgId, hash) {
      return mintPostgresToken(db, limits, orgId, hash);
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
    async purgeRevoked(orgId, id) {
      const rows = await db
        .delete(scimTokens)
        .where(
          and(
            eq(scimTokens.organizationId, orgId),
            eq(scimTokens.id, id),
            isNotNull(scimTokens.revokedAt),
          ),
        )
        .returning({ id: scimTokens.id });
      return rows.length > 0;
    },
    async count(orgId) {
      const [row] = await db
        .select({ total: sql<number>`count(*)::integer` })
        .from(scimTokens)
        .where(eq(scimTokens.organizationId, orgId));
      return row?.total ?? 0;
    },
    async list(orgId, input) {
      const page = scimAdminPage(input);
      if (page.limit === 0 || page.offset >= 2_147_483_647) return [];
      const rows = await db
        .select()
        .from(scimTokens)
        .where(eq(scimTokens.organizationId, orgId))
        .orderBy(asc(scimTokens.createdAt), asc(scimTokens.id))
        .limit(page.limit)
        .offset(page.offset);
      return rows.map((row) => ({
        id: row.id,
        organizationId: row.organizationId,
        createdAt: row.createdAt,
        ...(row.revokedAt ? { revokedAt: row.revokedAt } : undefined),
      }));
    },
  };
}
