import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OrganizationMembershipWithdrawal } from "../src/repos/interfaces.js";
import { fixture } from "./organization-membership-withdrawal-support.js";
import { type PgTestContext, createPgOwner } from "./pg-harness-full.js";

const owner = createPgOwner();
let pg: PgTestContext;
beforeAll(async () => {
  pg = await owner.acquire();
}, 60_000);
afterAll(async () => {
  await owner.close();
});

describe.each([
  { name: "memory", sql: false },
  { name: "SQL", sql: true },
])("$name withdrawal escalation", ({ sql }) => {
  it("keeps the fence and prevents an old role completion after directory removal", async () => {
    const { store, row } = await fixture(pg, sql);
    const initial = await store.findVersioned(
      row.organizationId,
      row.principalId,
    );
    if (!initial) throw new Error("expected membership");
    const roleChange: OrganizationMembershipWithdrawal = {
      id: randomUUID(),
      kind: "change_role",
      role: "admin",
      actorType: "human",
      actorPrincipalId: "owner",
      correlationId: "role-request",
    };
    const removal: OrganizationMembershipWithdrawal = {
      id: roleChange.id,
      kind: "remove",
      reason: "scim_deactivated",
      actorType: "system",
      actorPrincipalId: "directory",
      correlationId: "scim-request",
    };
    expect(
      await store.beginWithdrawal(
        row.organizationId,
        row.principalId,
        initial.incarnation,
        initial.authorityRevision,
        roleChange,
      ),
    ).toBe(true);
    expect(
      await store.upgradeRoleWithdrawalToRemoval(
        row.organizationId,
        row.principalId,
        initial.incarnation,
        randomUUID(),
        roleChange.id,
        removal,
      ),
    ).toBe(false);
    expect(
      await store.upgradeRoleWithdrawalToRemoval(
        row.organizationId,
        row.principalId,
        initial.incarnation,
        initial.authorityRevision,
        roleChange.id,
        { ...removal, actorType: "human" },
      ),
    ).toBe(false);
    expect(
      await store.upgradeRoleWithdrawalToRemoval(
        row.organizationId,
        row.principalId,
        initial.incarnation,
        initial.authorityRevision,
        roleChange.id,
        removal,
      ),
    ).toBe(true);
    expect(await store.hasPendingWithdrawalForPrincipal(row.principalId)).toBe(
      true,
    );
    expect(
      await store.findVersioned(row.organizationId, row.principalId),
    ).toEqual({ ...initial, withdrawalId: removal.id, withdrawal: removal });
    expect(
      await store.completeRoleWithdrawal(
        row.organizationId,
        row.principalId,
        initial.incarnation,
        roleChange.id,
        "admin",
        row.updatedAt,
      ),
    ).toBeUndefined();
    expect(
      await store.removeIfIncarnation(
        row.organizationId,
        row.principalId,
        initial.incarnation,
        removal.id,
      ),
    ).toBe(true);
    expect(await store.hasPendingWithdrawalForPrincipal(row.principalId)).toBe(
      false,
    );
  });

  it("atomically chooses between role completion and escalation", async () => {
    const { store, row } = await fixture(pg, sql);
    const initial = await store.findVersioned(
      row.organizationId,
      row.principalId,
    );
    if (!initial) throw new Error("expected membership");
    const roleChange: OrganizationMembershipWithdrawal = {
      id: randomUUID(),
      kind: "change_role",
      role: "admin",
      actorType: "human",
      actorPrincipalId: "owner",
      correlationId: "role",
    };
    const removal: OrganizationMembershipWithdrawal = {
      id: roleChange.id,
      kind: "remove",
      reason: "ldap_directory_sync",
      actorType: "system",
      actorPrincipalId: "directory",
      correlationId: "ldap",
    };
    expect(
      await store.beginWithdrawal(
        row.organizationId,
        row.principalId,
        initial.incarnation,
        initial.authorityRevision,
        roleChange,
      ),
    ).toBe(true);
    const [upgraded, completed] = await Promise.all([
      store.upgradeRoleWithdrawalToRemoval(
        row.organizationId,
        row.principalId,
        initial.incarnation,
        initial.authorityRevision,
        roleChange.id,
        removal,
      ),
      store.completeRoleWithdrawal(
        row.organizationId,
        row.principalId,
        initial.incarnation,
        roleChange.id,
        "admin",
        row.updatedAt,
      ),
    ]);
    expect(Number(upgraded) + Number(completed !== undefined)).toBe(1);
    if (upgraded) {
      expect(
        await store.findVersioned(row.organizationId, row.principalId),
      ).toEqual({ ...initial, withdrawalId: removal.id, withdrawal: removal });
      expect(
        await store.removeIfIncarnation(
          row.organizationId,
          row.principalId,
          initial.incarnation,
          removal.id,
        ),
      ).toBe(true);
    } else {
      expect(completed?.membership.role).toBe("admin");
      expect(completed?.authorityRevision).not.toBe(initial.authorityRevision);
      expect(completed?.withdrawal).toBeUndefined();
    }
  });
});
