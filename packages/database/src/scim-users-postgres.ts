import { randomUUID } from "node:crypto";
import { overlapCast } from "@opensesame/os-domain";
import { and, asc, count, eq, gt } from "drizzle-orm";
import { isUniqueViolation } from "./client-origin-store.js";
import { ConflictError } from "./repos/interfaces.js";
import type { Database } from "./repos/postgres.js";
import * as schema from "./schema/index.js";
import type {
  ScimUserRecord,
  ScimUserStore,
  VersionedScimUser,
} from "./scim-store.js";
import {
  assertScimIdentity,
  mapScimUser,
  normalizeScimUser,
} from "./scim-users-common.js";
import { isCanonicalUuid } from "./uuid.js";

export class PostgresScimUserStore implements ScimUserStore {
  constructor(private readonly db: Database) {}

  async create(user: ScimUserRecord): Promise<ScimUserRecord> {
    const row = normalizeScimUser(user);
    try {
      const [inserted] = await this.db
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
        throw new ConflictError(`scim user already exists: ${row.userName}`);
      }
      throw error;
    }
  }

  async createWithinLimit(
    user: ScimUserRecord,
    limit: number,
  ): Promise<ScimUserRecord | null> {
    const row = normalizeScimUser(user);
    try {
      return await this.db.transaction(async (tx) => {
        // Lock the tenant through admission so separate API processes share it.
        const [organization] = await tx
          .select({ id: schema.organizations.id })
          .from(schema.organizations)
          .where(eq(schema.organizations.id, row.organizationId))
          .for("update");
        if (!organization) {
          throw new Error(`scim organization not found: ${row.organizationId}`);
        }
        const [duplicate] = await tx
          .select({ id: schema.scimUsers.id })
          .from(schema.scimUsers)
          .where(
            and(
              eq(schema.scimUsers.organizationId, row.organizationId),
              eq(schema.scimUsers.userName, row.userName),
            ),
          )
          .limit(1);
        if (duplicate) {
          throw new ConflictError(`scim user already exists: ${row.userName}`);
        }
        const [total] = await tx
          .select({ value: count() })
          .from(schema.scimUsers)
          .where(eq(schema.scimUsers.organizationId, row.organizationId));
        if (Number(total?.value ?? 0) >= limit) return null;
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
        if (!inserted) throw new Error("insert scim user returned no row");
        return mapScimUser(inserted);
      });
    } catch (error) {
      if (error instanceof ConflictError) throw error;
      if (isUniqueViolation(overlapCast(error))) {
        throw new ConflictError(`scim user already exists: ${row.userName}`);
      }
      throw error;
    }
  }

  async countByOrganization(orgId: string): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(schema.scimUsers)
      .where(eq(schema.scimUsers.organizationId, orgId));
    return Number(row?.value ?? 0);
  }

  async getVersioned(
    orgId: string,
    id: string,
  ): Promise<VersionedScimUser | null> {
    const [row] = await this.db
      .select()
      .from(schema.scimUsers)
      .where(
        and(
          eq(schema.scimUsers.organizationId, orgId),
          eq(schema.scimUsers.id, id),
        ),
      )
      .limit(1);
    return row ? { user: mapScimUser(row), revision: row.revision } : null;
  }

  async getById(orgId: string, id: string): Promise<ScimUserRecord | null> {
    return (await this.getVersioned(orgId, id))?.user ?? null;
  }

  async findByUserName(
    orgId: string,
    userName: string,
  ): Promise<ScimUserRecord | null> {
    const [row] = await this.db
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
  }

  async findBySubject(
    orgId: string,
    subject: string,
  ): Promise<ScimUserRecord | null> {
    const [byExternalId] = await this.db
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
    return this.findByUserName(orgId, subject);
  }

  private async write(
    user: ScimUserRecord,
    expectedRevision?: string,
  ): Promise<VersionedScimUser | undefined> {
    const row = normalizeScimUser(user);
    try {
      const [updated] = await this.db
        .update(schema.scimUsers)
        .set({
          externalId: row.externalId ?? null,
          userName: row.userName,
          active: row.active,
          displayName: row.displayName ?? null,
          raw: row.raw,
          updatedAt: row.updatedAt,
          revision: randomUUID(),
        })
        .where(
          and(
            eq(schema.scimUsers.organizationId, row.organizationId),
            eq(schema.scimUsers.id, row.id),
            expectedRevision === undefined
              ? undefined
              : eq(schema.scimUsers.revision, expectedRevision),
          ),
        )
        .returning();
      return updated
        ? { user: mapScimUser(updated), revision: updated.revision }
        : undefined;
    } catch (error) {
      if (isUniqueViolation(overlapCast(error))) {
        throw new ConflictError(`scim user already exists: ${row.userName}`);
      }
      throw error;
    }
  }

  async update(user: ScimUserRecord): Promise<ScimUserRecord> {
    const updated = await this.write(user);
    if (!updated) throw new ConflictError(`scim user not found: ${user.id}`);
    return updated.user;
  }

  async replaceIfRevision(
    orgId: string,
    id: string,
    expectedRevision: string,
    next: ScimUserRecord,
  ): Promise<VersionedScimUser | undefined> {
    assertScimIdentity(orgId, id, next);
    if (!isCanonicalUuid(expectedRevision)) {
      return undefined;
    }
    return this.write(next, expectedRevision);
  }

  async listByOrganization(
    orgId: string,
    page?: { offset: number; limit: number },
  ): Promise<ScimUserRecord[]> {
    const base = this.db
      .select()
      .from(schema.scimUsers)
      .where(eq(schema.scimUsers.organizationId, orgId))
      .orderBy(asc(schema.scimUsers.createdAt), asc(schema.scimUsers.id));
    const rows = page
      ? await base.limit(page.limit).offset(page.offset)
      : await base;
    return rows.map(mapScimUser);
  }

  async listInactiveForRecovery(afterId: string | undefined, limit: number) {
    return this.db
      .select({
        id: schema.scimUsers.id,
        organizationId: schema.scimUsers.organizationId,
      })
      .from(schema.scimUsers)
      .where(
        and(
          eq(schema.scimUsers.active, false),
          afterId === undefined ? undefined : gt(schema.scimUsers.id, afterId),
        ),
      )
      .orderBy(asc(schema.scimUsers.id))
      .limit(limit);
  }
}
