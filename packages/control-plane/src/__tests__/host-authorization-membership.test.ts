import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { fixture } from "./host-authorization-fixture.js";

vi.setConfig({ testTimeout: 60_000 });

it("rejects a challenge captured before membership authority rotates", async () => {
  const f = await fixture();
  const pending = await f.begin();
  const [org, principal] = [f.challenge.organization_id, f.minted.principalId];
  const memberships = f.ctx.stores.organizationMemberships;
  const membership = await memberships.findVersioned(org, principal);
  if (!membership) throw new Error("Missing membership");
  const { incarnation, authorityRevision } = membership;
  const id = randomUUID();
  const withdrawal = {
    id,
    kind: "change_role" as const,
    role: "admin" as const,
  };
  const actor = { actorType: "system" as const, actorPrincipalId: principal };
  const correlationId = "stale-host-authorization";
  expect(
    await memberships.beginWithdrawal(
      org,
      principal,
      incarnation,
      authorityRevision,
      {
        ...withdrawal,
        ...actor,
        correlationId,
      },
    ),
  ).toBe(true);
  expect(
    await memberships.completeRoleWithdrawal(
      org,
      principal,
      incarnation,
      id,
      "admin",
      new Date(),
    ),
  ).toBeDefined();
  expect((await f.verify(f.assertion(pending))).status).toBe(403);
  const fresh = await f.begin();
  expect((await f.verify(f.assertion(fresh, true, 2))).status).toBe(200);
});
