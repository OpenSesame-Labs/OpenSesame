import type { ByoUpstream, JsonObject } from "@opensesame/os-domain";
import { overlapCast } from "@opensesame/os-domain";
import { and, count, eq, sql } from "drizzle-orm";
import { isUniqueViolation } from "./client-origin-store.js";
import { ConflictError, normalizeIssuer } from "./repos/interfaces.js";
import type { Database } from "./repos/postgres.js";
import * as schema from "./schema/index.js";
import { mapScimUser, normalizeScimUser } from "./scim-users-common.js";

export { mapScimUser, normalizeScimUser } from "./scim-users-common.js";

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

/** Internal concurrency metadata; it is not part of a SCIM user response. */
export interface VersionedScimUser {
  user: ScimUserRecord;
  revision: string;
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
  getVersioned(orgId: string, id: string): Promise<VersionedScimUser | null>;
  findByUserName(
    orgId: string,
    userName: string,
  ): Promise<ScimUserRecord | null>;
  /** Prefer the IdP's stable external id; userName is the documented fallback. */
  findBySubject(orgId: string, subject: string): Promise<ScimUserRecord | null>;
  update(user: ScimUserRecord): Promise<ScimUserRecord>;
  replaceIfRevision(
    orgId: string,
    id: string,
    expectedRevision: string,
    next: ScimUserRecord,
  ): Promise<VersionedScimUser | undefined>;
  countByOrganization(orgId: string): Promise<number>;
  listByOrganization(
    orgId: string,
    page?: { offset: number; limit: number },
  ): Promise<ScimUserRecord[]>;
  /** Stable, bounded global scan used to fence legacy inactive users at startup. */
  listInactiveForRecovery(
    afterId: string | undefined,
    limit: number,
  ): Promise<Array<{ id: string; organizationId: string }>>;
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
