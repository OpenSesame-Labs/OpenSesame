import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ConflictError,
  type OrganizationMembershipWithdrawal,
} from "../src/repos/interfaces.js";
import { organizationMemberships } from "../src/schema/index.js";
import {
  fixture,
  removal,
} from "./organization-membership-withdrawal-support.js";
import { type PgTestContext, createPgOwner } from "./pg-harness-full.js";

const pgOwner = createPgOwner();
let pg: PgTestContext;
beforeAll(async () => {
  pg = await pgOwner.acquire();
}, 60_000);
afterAll(async () => {
  await pgOwner.close();
});

describe.each([
  { name: "memory", sql: false },
  { name: "SQL", sql: true },
])("$name membership withdrawal", ({ sql }) => {
  it("persists one competing intent and requires its exact token", async () => {
    const { store, row } = await fixture(pg, sql);
    const initial = await store.findVersioned(
      row.organizationId,
      row.principalId,
    );
    if (!initial) throw new Error("expected membership");
    expect(await store.hasPendingWithdrawalForPrincipal(row.principalId)).toBe(
      false,
    );
    const candidates = [removal(randomUUID()), removal(randomUUID())];
    const acquired = await Promise.all(
      candidates.map((intent) =>
        store.beginWithdrawal(
          row.organizationId,
          row.principalId,
          initial.incarnation,
          initial.authorityRevision,
          intent,
        ),
      ),
    );
    expect(acquired.filter(Boolean)).toHaveLength(1);
    const intent = candidates[acquired.findIndex(Boolean)];
    const other = candidates.find((candidate) => candidate.id !== intent?.id);
    if (!intent || !other) throw new Error("expected competing intents");
    expect(await store.hasPendingWithdrawalForPrincipal(row.principalId)).toBe(
      true,
    );
    expect(
      await store.hasPendingWithdrawalForPrincipal("another-principal"),
    ).toBe(false);
    const pending = { ...initial, withdrawalId: intent.id, withdrawal: intent };
    expect(
      await store.findVersioned(row.organizationId, row.principalId),
    ).toEqual(pending);
    expect(await store.listVersionedByOrganization(row.organizationId)).toEqual(
      [pending],
    );
    expect(await store.listPendingWithdrawals()).toContainEqual(pending);
    expect(await store.find(row.organizationId, row.principalId)).toEqual(row);
    expect(await store.remove(row.organizationId, row.principalId)).toBe(false);
    expect(
      await store.removeIfIncarnation(
        row.organizationId,
        row.principalId,
        initial.incarnation,
      ),
    ).toBe(false);
    expect(
      await store.removeIfIncarnation(
        row.organizationId,
        row.principalId,
        initial.incarnation,
        other.id,
      ),
    ).toBe(false);
    expect(
      await store.clearWithdrawal(
        row.organizationId,
        row.principalId,
        initial.incarnation,
        other.id,
      ),
    ).toBe(false);
    await expect(
      Promise.resolve().then(() => store.upsert({ ...row, role: "admin" })),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(
      await store.findVersioned(row.organizationId, row.principalId),
    ).toEqual(pending);
    expect(
      await store.clearWithdrawal(
        row.organizationId,
        row.principalId,
        initial.incarnation,
        intent.id,
      ),
    ).toBe(true);
    expect(await store.hasPendingWithdrawalForPrincipal(row.principalId)).toBe(
      false,
    );
    expect(
      await store.removeIfIncarnation(
        row.organizationId,
        row.principalId,
        initial.incarnation,
        intent.id,
      ),
    ).toBe(false);
    expect(
      await store.beginWithdrawal(
        row.organizationId,
        row.principalId,
        initial.incarnation,
        initial.authorityRevision,
        removal("invalid"),
      ),
    ).toBe(false);
    expect(
      await store.beginWithdrawal(
        row.organizationId,
        row.principalId,
        initial.incarnation,
        initial.authorityRevision,
        other,
      ),
    ).toBe(true);
    expect(
      await store.removeIfIncarnation(
        row.organizationId,
        row.principalId,
        initial.incarnation,
        other.id,
      ),
    ).toBe(true);
  });

  it("rotates authority only when the recorded role change completes", async () => {
    const { store, row } = await fixture(pg, sql);
    const initial = await store.findVersioned(
      row.organizationId,
      row.principalId,
    );
    if (!initial) throw new Error("expected membership");
    const intent: OrganizationMembershipWithdrawal = {
      id: randomUUID(),
      kind: "change_role",
      role: "admin",
      actorType: "system",
      actorPrincipalId: "directory",
      correlationId: "request-2",
    };
    expect(
      await store.beginWithdrawal(
        row.organizationId,
        row.principalId,
        initial.incarnation,
        initial.authorityRevision,
        intent,
      ),
    ).toBe(true);
    const pending = await store.findVersioned(
      row.organizationId,
      row.principalId,
    );
    expect(pending?.authorityRevision).toBe(initial.authorityRevision);
    expect(pending?.withdrawal).toEqual(intent);
    expect(
      await store.removeIfIncarnation(
        row.organizationId,
        row.principalId,
        initial.incarnation,
        intent.id,
      ),
    ).toBe(false);
    expect(
      await store.completeRoleWithdrawal(
        row.organizationId,
        row.principalId,
        initial.incarnation,
        intent.id,
        "owner",
        row.updatedAt,
      ),
    ).toBeUndefined();
    expect(
      await store.completeRoleWithdrawal(
        row.organizationId,
        row.principalId,
        initial.incarnation,
        randomUUID(),
        "admin",
        row.updatedAt,
      ),
    ).toBeUndefined();
    const updatedAt = new Date("2026-08-25T09:00:00.000Z");
    const completed = await store.completeRoleWithdrawal(
      row.organizationId,
      row.principalId,
      initial.incarnation,
      intent.id,
      "admin",
      updatedAt,
    );
    expect(completed?.membership).toEqual({ ...row, role: "admin", updatedAt });
    expect(completed?.incarnation).toBe(initial.incarnation);
    expect(completed?.authorityRevision).not.toBe(initial.authorityRevision);
    expect(completed?.withdrawal).toBeUndefined();
    expect(
      await store.findVersioned(row.organizationId, row.principalId),
    ).toEqual(completed);
    expect(await store.listPendingWithdrawals()).not.toContainEqual(pending);
  });

  it("does not let an old withdrawal affect a replacement membership", async () => {
    const { store, row } = await fixture(pg, sql);
    const first = await store.findVersioned(
      row.organizationId,
      row.principalId,
    );
    if (!first) throw new Error("expected membership");
    const firstIntent = removal(randomUUID());
    expect(
      await store.beginWithdrawal(
        row.organizationId,
        row.principalId,
        first.incarnation,
        first.authorityRevision,
        firstIntent,
      ),
    ).toBe(true);
    expect(
      await store.removeIfIncarnation(
        row.organizationId,
        row.principalId,
        first.incarnation,
        firstIntent.id,
      ),
    ).toBe(true);
    await store.upsert(row);
    const replacement = await store.findVersioned(
      row.organizationId,
      row.principalId,
    );
    if (!replacement) throw new Error("expected replacement");
    const nextIntent = removal(randomUUID());
    expect(replacement.incarnation).not.toBe(first.incarnation);
    expect(
      await store.beginWithdrawal(
        row.organizationId,
        row.principalId,
        replacement.incarnation,
        replacement.authorityRevision,
        nextIntent,
      ),
    ).toBe(true);
    expect(
      await store.clearWithdrawal(
        row.organizationId,
        row.principalId,
        first.incarnation,
        firstIntent.id,
      ),
    ).toBe(false);
    expect(
      await store.removeIfIncarnation(
        row.organizationId,
        row.principalId,
        first.incarnation,
        firstIntent.id,
      ),
    ).toBe(false);
    expect(
      await store.findVersioned(row.organizationId, row.principalId),
    ).toEqual({
      ...replacement,
      withdrawalId: nextIntent.id,
      withdrawal: nextIntent,
    });
    expect(
      await store.removeIfIncarnation(
        row.organizationId,
        row.principalId,
        replacement.incarnation,
        nextIntent.id,
      ),
    ).toBe(true);
  });

  it("does not begin against a stale authority revision of the same incarnation", async () => {
    const { store, row } = await fixture(pg, sql);
    const first = await store.findVersioned(
      row.organizationId,
      row.principalId,
    );
    if (!first) throw new Error("expected membership");
    await store.upsert({ ...row, role: "admin" });
    const current = await store.findVersioned(
      row.organizationId,
      row.principalId,
    );
    if (!current) throw new Error("expected membership");
    const intent = removal(randomUUID());
    expect(current.incarnation).toBe(first.incarnation);
    expect(current.authorityRevision).not.toBe(first.authorityRevision);
    expect(
      await store.beginWithdrawal(
        row.organizationId,
        row.principalId,
        first.incarnation,
        first.authorityRevision,
        intent,
      ),
    ).toBe(false);
    expect(
      await store.beginWithdrawal(
        row.organizationId,
        row.principalId,
        current.incarnation,
        current.authorityRevision,
        intent,
      ),
    ).toBe(true);
    expect(
      await store.removeIfIncarnation(
        row.organizationId,
        row.principalId,
        current.incarnation,
        intent.id,
      ),
    ).toBe(true);
  });
});

it("blocks an older SQL writer from changing a role during withdrawal", async () => {
  const { store, row } = await fixture(pg, true);
  const current = await store.findVersioned(
    row.organizationId,
    row.principalId,
  );
  if (!current) throw new Error("expected membership");
  const intent = removal(randomUUID());
  expect(
    await store.beginWithdrawal(
      row.organizationId,
      row.principalId,
      current.incarnation,
      current.authorityRevision,
      intent,
    ),
  ).toBe(true);
  await expect(
    pg.db
      .update(organizationMemberships)
      .set({ role: "admin" })
      .where(eq(organizationMemberships.principalId, row.principalId)),
  ).rejects.toThrow();
  expect(
    await store.findVersioned(row.organizationId, row.principalId),
  ).toEqual({ ...current, withdrawalId: intent.id, withdrawal: intent });
  expect(
    await store.removeIfIncarnation(
      row.organizationId,
      row.principalId,
      current.incarnation,
      intent.id,
    ),
  ).toBe(true);
});
