import { randomUUID } from "node:crypto";
import type {
  OrganizationMembership,
  OrganizationRole,
} from "@opensesame/os-domain";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import * as schema from "../schema/index.js";
import { isCanonicalUuid } from "../uuid.js";
import { ConflictError } from "./errors.js";
import type {
  OrganizationMembershipStore,
  OrganizationMembershipWithdrawal,
  PendingOrganizationMembershipWithdrawal,
  VersionedOrganizationMembership,
} from "./organization-interfaces.js";
import {
  mapOrganizationMembership,
  mapVersionedMembership,
} from "./organization-membership-map.js";
import { validOrganizationWithdrawal } from "./organization-withdrawal.js";
import type { Database } from "./postgres.js";

/** Postgres membership rows behind the `OrganizationMembershipStore` interface. */
export class PostgresOrganizationMembershipStore
  implements OrganizationMembershipStore
{
  constructor(private readonly db: Database) {}

  async find(
    organizationId: string,
    principalId: string,
  ): Promise<OrganizationMembership | undefined> {
    const [row] = await this.db
      .select()
      .from(schema.organizationMemberships)
      .where(
        and(
          eq(schema.organizationMemberships.organizationId, organizationId),
          eq(schema.organizationMemberships.principalId, principalId),
        ),
      )
      .limit(1);
    return row ? mapOrganizationMembership(row) : undefined;
  }

  async findVersioned(
    organizationId: string,
    principalId: string,
  ): Promise<VersionedOrganizationMembership | undefined> {
    const [row] = await this.db
      .select()
      .from(schema.organizationMemberships)
      .where(
        and(
          eq(schema.organizationMemberships.organizationId, organizationId),
          eq(schema.organizationMemberships.principalId, principalId),
        ),
      )
      .limit(1);
    return row ? mapVersionedMembership(row) : undefined;
  }

  async upsert(
    membership: OrganizationMembership,
  ): Promise<OrganizationMembership> {
    const [row] = await this.db
      .insert(schema.organizationMemberships)
      .values({
        organizationId: membership.organizationId,
        principalId: membership.principalId,
        role: membership.role,
        createdAt: membership.createdAt,
        updatedAt: membership.updatedAt,
      })
      .onConflictDoUpdate({
        target: [
          schema.organizationMemberships.organizationId,
          schema.organizationMemberships.principalId,
        ],
        set: {
          role: membership.role,
          createdAt: membership.createdAt,
          updatedAt: membership.updatedAt,
        },
        setWhere: isNull(schema.organizationMemberships.withdrawalId),
      })
      .returning();
    if (!row) throw new ConflictError("membership withdrawal in progress");
    return mapOrganizationMembership(row);
  }

  async remove(organizationId: string, principalId: string): Promise<boolean> {
    const rows = await this.db
      .delete(schema.organizationMemberships)
      .where(
        and(
          eq(schema.organizationMemberships.organizationId, organizationId),
          eq(schema.organizationMemberships.principalId, principalId),
          isNull(schema.organizationMemberships.withdrawalId),
        ),
      )
      .returning({
        organizationId: schema.organizationMemberships.organizationId,
      });
    return rows.length > 0;
  }

  async removeIfIncarnation(
    organizationId: string,
    principalId: string,
    incarnation: string,
    withdrawalId?: string,
  ): Promise<boolean> {
    // Tokens are opaque canonical UUID strings. Invalid tokens cannot match
    // and must not turn a conditional removal into a Postgres cast error.
    if (
      !isCanonicalUuid(incarnation) ||
      (withdrawalId !== undefined && !isCanonicalUuid(withdrawalId))
    ) {
      return false;
    }
    const rows = await this.db
      .delete(schema.organizationMemberships)
      .where(
        and(
          eq(schema.organizationMemberships.organizationId, organizationId),
          eq(schema.organizationMemberships.principalId, principalId),
          eq(schema.organizationMemberships.incarnation, incarnation),
          withdrawalId === undefined
            ? isNull(schema.organizationMemberships.withdrawalId)
            : and(
                eq(schema.organizationMemberships.withdrawalId, withdrawalId),
                eq(schema.organizationMemberships.withdrawalKind, "remove"),
              ),
        ),
      )
      .returning({
        organizationId: schema.organizationMemberships.organizationId,
      });
    return rows.length > 0;
  }

  async beginWithdrawal(
    organizationId: string,
    principalId: string,
    incarnation: string,
    authorityRevision: string,
    withdrawal: OrganizationMembershipWithdrawal,
  ): Promise<boolean> {
    if (
      !isCanonicalUuid(incarnation) ||
      !isCanonicalUuid(authorityRevision) ||
      !validOrganizationWithdrawal(withdrawal)
    )
      return false;
    const rows = await this.db
      .update(schema.organizationMemberships)
      .set({
        withdrawalId: withdrawal.id,
        withdrawalKind: withdrawal.kind,
        withdrawalRole:
          withdrawal.kind === "change_role" ? withdrawal.role : null,
        withdrawalReason:
          withdrawal.kind === "remove" ? (withdrawal.reason ?? null) : null,
        withdrawalActorType: withdrawal.actorType,
        withdrawalActorPrincipalId: withdrawal.actorPrincipalId,
        withdrawalCorrelationId: withdrawal.correlationId,
      })
      .where(
        and(
          eq(schema.organizationMemberships.organizationId, organizationId),
          eq(schema.organizationMemberships.principalId, principalId),
          eq(schema.organizationMemberships.incarnation, incarnation),
          eq(
            schema.organizationMemberships.authorityRevision,
            authorityRevision,
          ),
          isNull(schema.organizationMemberships.withdrawalId),
        ),
      )
      .returning({
        organizationId: schema.organizationMemberships.organizationId,
      });
    return rows.length > 0;
  }

  async clearWithdrawal(
    organizationId: string,
    principalId: string,
    incarnation: string,
    withdrawalId: string,
  ): Promise<boolean> {
    if (!isCanonicalUuid(incarnation) || !isCanonicalUuid(withdrawalId))
      return false;
    const rows = await this.db
      .update(schema.organizationMemberships)
      .set({
        withdrawalId: null,
        withdrawalKind: null,
        withdrawalRole: null,
        withdrawalReason: null,
        withdrawalActorType: null,
        withdrawalActorPrincipalId: null,
        withdrawalCorrelationId: null,
      })
      .where(
        and(
          eq(schema.organizationMemberships.organizationId, organizationId),
          eq(schema.organizationMemberships.principalId, principalId),
          eq(schema.organizationMemberships.incarnation, incarnation),
          eq(schema.organizationMemberships.withdrawalId, withdrawalId),
        ),
      )
      .returning({
        organizationId: schema.organizationMemberships.organizationId,
      });
    return rows.length > 0;
  }

  async completeRoleWithdrawal(
    organizationId: string,
    principalId: string,
    incarnation: string,
    withdrawalId: string,
    role: OrganizationRole,
    updatedAt: Date,
  ): Promise<VersionedOrganizationMembership | undefined> {
    if (!isCanonicalUuid(incarnation) || !isCanonicalUuid(withdrawalId))
      return undefined;
    const [row] = await this.db
      .update(schema.organizationMemberships)
      .set({
        role,
        updatedAt,
        authorityRevision: randomUUID(),
        withdrawalId: null,
        withdrawalKind: null,
        withdrawalRole: null,
        withdrawalReason: null,
        withdrawalActorType: null,
        withdrawalActorPrincipalId: null,
        withdrawalCorrelationId: null,
      })
      .where(
        and(
          eq(schema.organizationMemberships.organizationId, organizationId),
          eq(schema.organizationMemberships.principalId, principalId),
          eq(schema.organizationMemberships.incarnation, incarnation),
          eq(schema.organizationMemberships.withdrawalId, withdrawalId),
          eq(schema.organizationMemberships.withdrawalKind, "change_role"),
          eq(schema.organizationMemberships.withdrawalRole, role),
        ),
      )
      .returning();
    return row ? mapVersionedMembership(row) : undefined;
  }

  async upgradeRoleWithdrawalToRemoval(
    organizationId: string,
    principalId: string,
    incarnation: string,
    authorityRevision: string,
    previousWithdrawalId: string,
    withdrawal: OrganizationMembershipWithdrawal,
  ): Promise<boolean> {
    if (
      !isCanonicalUuid(incarnation) ||
      !isCanonicalUuid(authorityRevision) ||
      !validOrganizationWithdrawal(withdrawal) ||
      withdrawal.kind !== "remove" ||
      withdrawal.actorType !== "system" ||
      withdrawal.id !== previousWithdrawalId
    )
      return false;
    const rows = await this.db
      .update(schema.organizationMemberships)
      .set({
        withdrawalKind: "remove",
        withdrawalRole: null,
        withdrawalReason: withdrawal.reason ?? null,
        withdrawalActorType: withdrawal.actorType,
        withdrawalActorPrincipalId: withdrawal.actorPrincipalId,
        withdrawalCorrelationId: withdrawal.correlationId,
      })
      .where(
        and(
          eq(schema.organizationMemberships.organizationId, organizationId),
          eq(schema.organizationMemberships.principalId, principalId),
          eq(schema.organizationMemberships.incarnation, incarnation),
          eq(
            schema.organizationMemberships.authorityRevision,
            authorityRevision,
          ),
          eq(schema.organizationMemberships.withdrawalId, previousWithdrawalId),
          eq(schema.organizationMemberships.withdrawalKind, "change_role"),
        ),
      )
      .returning({
        organizationId: schema.organizationMemberships.organizationId,
      });
    return rows.length > 0;
  }

  async listPendingWithdrawals(): Promise<
    PendingOrganizationMembershipWithdrawal[]
  > {
    const rows = await this.db
      .select()
      .from(schema.organizationMemberships)
      .where(isNotNull(schema.organizationMemberships.withdrawalId));
    return rows.map((row) => {
      const result = mapVersionedMembership(row);
      if (!result.withdrawal || !result.withdrawalId)
        throw new Error("membership withdrawal intent is missing");
      return {
        ...result,
        withdrawal: result.withdrawal,
        withdrawalId: result.withdrawalId,
      };
    });
  }

  async hasPendingWithdrawalForPrincipal(
    principalId: string,
  ): Promise<boolean> {
    const rows = await this.db
      .select({ principalId: schema.organizationMemberships.principalId })
      .from(schema.organizationMemberships)
      .where(
        and(
          eq(schema.organizationMemberships.principalId, principalId),
          isNotNull(schema.organizationMemberships.withdrawalId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async listByOrganization(
    organizationId: string,
  ): Promise<OrganizationMembership[]> {
    const rows = await this.db
      .select()
      .from(schema.organizationMemberships)
      .where(eq(schema.organizationMemberships.organizationId, organizationId));
    return rows.map(mapOrganizationMembership);
  }

  async listVersionedByOrganization(
    organizationId: string,
  ): Promise<VersionedOrganizationMembership[]> {
    const rows = await this.db
      .select()
      .from(schema.organizationMemberships)
      .where(eq(schema.organizationMemberships.organizationId, organizationId));
    return rows.map(mapVersionedMembership);
  }

  async listByPrincipal(
    principalId: string,
  ): Promise<OrganizationMembership[]> {
    const rows = await this.db
      .select()
      .from(schema.organizationMemberships)
      .where(eq(schema.organizationMemberships.principalId, principalId));
    return rows.map(mapOrganizationMembership);
  }

  async countOwners(organizationId: string): Promise<number> {
    const rows = await this.db
      .select({ principalId: schema.organizationMemberships.principalId })
      .from(schema.organizationMemberships)
      .where(
        and(
          eq(schema.organizationMemberships.organizationId, organizationId),
          eq(schema.organizationMemberships.role, "owner"),
        ),
      );
    return rows.length;
  }
}
