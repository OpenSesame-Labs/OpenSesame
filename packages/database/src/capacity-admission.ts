import type { ByoUpstream, JsonObject } from "@opensesame/os-domain";
import { overlapCast } from "@opensesame/os-domain";
import { and, count, eq, sql } from "drizzle-orm";
import { isUniqueViolation } from "./client-origin-store.js";
import { ConflictError, normalizeIssuer } from "./repos/interfaces.js";
import type { Database } from "./repos/postgres.js";
import * as schema from "./schema/index.js";

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

export interface ScimUserStore {
  create(user: ScimUserRecord): Promise<ScimUserRecord>;
  /**
   * Atomically create only while the tenant remains below its durable limit.
   * Duplicate user names win over the capacity response; null means full.
   */
  createWithinLimit(
    user: ScimUserRecord,
    limit: number,
  ): Promise<ScimUserRecord | null>;
  getById(orgId: string, id: string): Promise<ScimUserRecord | null>;
  getVersioned(
    orgId: string,
    id: string,
  ): Promise<{ user: ScimUserRecord; revision: string } | null>;
  replaceIfRevision(
    orgId: string,
    id: string,
    expectedRevision: string,
    next: ScimUserRecord,
  ): Promise<{ user: ScimUserRecord; revision: string } | undefined>;
  findByUserName(
    orgId: string,
    userName: string,
  ): Promise<ScimUserRecord | null>;
  /** Prefer the IdP's stable external id; userName is the documented fallback. */
  findBySubject(orgId: string, subject: string): Promise<ScimUserRecord | null>;
  update(user: ScimUserRecord): Promise<ScimUserRecord>;
  countByOrganization(orgId: string): Promise<number>;
  listByOrganization(
    orgId: string,
    page?: { offset: number; limit: number },
  ): Promise<ScimUserRecord[]>;
}

export function mapByoUpstream(
  row: typeof schema.byoUpstreams.$inferSelect,
): ByoUpstream {
  return {
    id: row.id,
    issuer: row.issuer,
    label: row.label,
    clientId: row.clientId,
    clientAuth: overlapCast(row.clientAuth),
    registrationSource: overlapCast(row.registrationSource),
    state: overlapCast(row.state),
    createdAt: row.createdAt,
    ...(row.clientSecret ? { clientSecret: row.clientSecret } : undefined),
    ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt } : undefined),
  };
}

export async function countPostgresByoUpstreams(db: Database): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)` })
    .from(schema.byoUpstreams);
  return Number(row?.value ?? 0);
}

export async function createPostgresByoWithinLimit(
  db: Database,
  record: ByoUpstream,
  limit: number,
): Promise<ByoUpstream | null> {
  const issuer = normalizeIssuer(record.issuer);
  try {
    return await db.transaction(async (tx) => {
      // The table lock is the deployment-wide mutex for this parentless set.
      await tx.execute(
        sql`LOCK TABLE ${schema.byoUpstreams} IN SHARE ROW EXCLUSIVE MODE`,
      );
      const [duplicate] = await tx
        .select({ id: schema.byoUpstreams.id })
        .from(schema.byoUpstreams)
        .where(eq(schema.byoUpstreams.issuer, issuer))
        .limit(1);
      if (duplicate) {
        throw new ConflictError(
          `byo upstream issuer already registered: ${issuer}`,
        );
      }
      const [total] = await tx
        .select({ value: sql<number>`count(*)` })
        .from(schema.byoUpstreams);
      if (Number(total?.value ?? 0) >= limit) return null;
      const [row] = await tx
        .insert(schema.byoUpstreams)
        .values({
          id: record.id,
          issuer,
          label: record.label,
          clientId: record.clientId,
          clientSecret: record.clientSecret ?? null,
          clientAuth: record.clientAuth,
          registrationSource: record.registrationSource,
          state: record.state,
          createdAt: record.createdAt,
          lastUsedAt: record.lastUsedAt ?? null,
        })
        .returning();
      if (!row) throw new Error("insert byo upstream returned no row");
      return mapByoUpstream(row);
    });
  } catch (error) {
    if (error instanceof ConflictError) throw error;
    if (isUniqueViolation(overlapCast(error))) {
      throw new ConflictError(
        `byo upstream issuer already registered: ${issuer}`,
      );
    }
    throw error;
  }
}

export function normalizeScimUser(user: ScimUserRecord): ScimUserRecord {
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

export function createMemoryScimWithinLimit(
  users: Map<string, ScimUserRecord>,
  user: ScimUserRecord,
  limit: number,
): ScimUserRecord | null {
  const row = normalizeScimUser(user);
  const scoped = [...users.values()].filter(
    (existing) => existing.organizationId === row.organizationId,
  );
  if (scoped.some((existing) => existing.userName === row.userName)) {
    throw new ConflictError(`scim user already exists: ${row.userName}`);
  }
  if (scoped.length >= limit) return null;
  users.set(row.id, row);
  return normalizeScimUser(row);
}

export function createMemoryScimUserStore(): ScimUserStore {
  const users = new Map<string, ScimUserRecord>();
  const revisions = new Map<string, string>();
  const ofOrg = (orgId: string) =>
    [...users.values()].filter((user) => user.organizationId === orgId);
  return {
    async create(user) {
      const row = normalizeScimUser(user);
      if (
        ofOrg(row.organizationId).some((item) => item.userName === row.userName)
      ) {
        throw new ConflictError(`scim user already exists: ${row.userName}`);
      }
      users.set(row.id, row);
      revisions.set(row.id, crypto.randomUUID());
      return normalizeScimUser(row);
    },
    async createWithinLimit(user, limit) {
      const created = createMemoryScimWithinLimit(users, user, limit);
      if (created) revisions.set(created.id, crypto.randomUUID());
      return created;
    },
    async getById(orgId, id) {
      const row = users.get(id);
      return row?.organizationId === orgId ? normalizeScimUser(row) : null;
    },
    async getVersioned(orgId, id) {
      const row = users.get(id);
      const revision = revisions.get(id);
      return row?.organizationId === orgId && revision
        ? { user: normalizeScimUser(row), revision }
        : null;
    },
    async replaceIfRevision(orgId, id, expectedRevision, next) {
      const row = users.get(id);
      if (
        !row ||
        row.organizationId !== orgId ||
        revisions.get(id) !== expectedRevision
      )
        return undefined;
      const normalized = normalizeScimUser(next);
      const revision = crypto.randomUUID();
      users.set(id, normalized);
      revisions.set(id, revision);
      return { user: normalizeScimUser(normalized), revision };
    },
    async findByUserName(orgId, userName) {
      const row = ofOrg(orgId).find((user) => user.userName === userName);
      return row ? normalizeScimUser(row) : null;
    },
    async findBySubject(orgId, subject) {
      const scoped = ofOrg(orgId);
      const external = scoped.find((user) => user.externalId === subject);
      if (external) return normalizeScimUser(external);
      const named = scoped.find((user) => user.userName === subject);
      return named ? normalizeScimUser(named) : null;
    },
    async update(user) {
      const row = normalizeScimUser(user);
      if (!users.has(row.id)) {
        throw new ConflictError(`scim user not found: ${row.id}`);
      }
      users.set(row.id, row);
      revisions.set(row.id, crypto.randomUUID());
      return normalizeScimUser(row);
    },
    async countByOrganization(orgId) {
      return ofOrg(orgId).length;
    },
    async listByOrganization(orgId, page) {
      const ordered = ofOrg(orgId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map(normalizeScimUser);
      return page
        ? ordered.slice(page.offset, page.offset + page.limit)
        : ordered;
    },
  };
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

export async function createPostgresScimWithinLimit(
  db: Database,
  user: ScimUserRecord,
  limit: number,
): Promise<ScimUserRecord | null> {
  const normalized = normalizeScimUser(user);
  try {
    return await db.transaction(async (tx) => {
      // Lock the tenant through admission so separate API processes share it.
      const [organization] = await tx
        .select({ id: schema.organizations.id })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, normalized.organizationId))
        .for("update");
      if (!organization) {
        throw new Error(
          `scim organization not found: ${normalized.organizationId}`,
        );
      }
      const [duplicate] = await tx
        .select({ id: schema.scimUsers.id })
        .from(schema.scimUsers)
        .where(
          and(
            eq(schema.scimUsers.organizationId, normalized.organizationId),
            eq(schema.scimUsers.userName, normalized.userName),
          ),
        )
        .limit(1);
      if (duplicate) {
        throw new ConflictError(
          `scim user already exists: ${normalized.userName}`,
        );
      }
      const [total] = await tx
        .select({ value: count() })
        .from(schema.scimUsers)
        .where(eq(schema.scimUsers.organizationId, normalized.organizationId));
      if (Number(total?.value ?? 0) >= limit) return null;
      const [inserted] = await tx
        .insert(schema.scimUsers)
        .values({
          id: normalized.id,
          organizationId: normalized.organizationId,
          externalId: normalized.externalId ?? null,
          userName: normalized.userName,
          active: normalized.active,
          displayName: normalized.displayName ?? null,
          raw: normalized.raw,
          createdAt: normalized.createdAt,
          updatedAt: normalized.updatedAt,
        })
        .returning();
      if (!inserted) throw new Error("insert scim user returned no row");
      return mapScimUser(inserted);
    });
  } catch (error) {
    if (error instanceof ConflictError) throw error;
    if (isUniqueViolation(overlapCast(error))) {
      throw new ConflictError(
        `scim user already exists: ${normalized.userName}`,
      );
    }
    throw error;
  }
}
