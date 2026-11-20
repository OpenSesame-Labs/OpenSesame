import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { ScimUserRecord, ScimUserStore } from "./capacity-admission.js";
import type { Database } from "./repos/postgres.js";
import * as schema from "./schema/index.js";
import { MemoryScimUserStore } from "./scim-users-memory.js";
import { PostgresScimUserStore } from "./scim-users-postgres.js";

/**
 * A SCIM 2.0 provisioned user (ADR 0056).
 *
 * No principal is minted at provision time: the row is the organization's
 * answer to "may this subject join?" when a sign-in eventually arrives.
 * `raw` keeps the attributes the IdP sent — SCIM's leniency norm is to accept
 * and echo what we do not model.
 */
export {
  SCIM_DEPROVISION_JOURNAL_ATTRIBUTE,
  type ScimUserRecord,
  type ScimUserStore,
} from "./capacity-admission.js";

/** Internal concurrency metadata; it is not part of a SCIM user response. */
export interface VersionedScimUser {
  user: ScimUserRecord;
  revision: string;
}

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
    users: new MemoryScimUserStore(),
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
    users: new PostgresScimUserStore(db),
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
