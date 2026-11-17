import * as schema from "@opensesame/database/schema";
import { overlapCast } from "@opensesame/os-domain";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";
import { migratedPGlite, warmMigratedPGlite } from "./migrated-pglite.js";
import {
  auth,
  createOrg,
  provisional,
  verified,
} from "./organizations-edge.test-support.js";

vi.setConfig({ testTimeout: 60_000 });
beforeAll(warmMigratedPGlite, 60_000);
afterEach(() => vi.restoreAllMocks());

function optionsFor(db: ReturnType<typeof drizzle<typeof schema>>) {
  return {
    database: overlapCast(db),
    config: {
      port: 0,
      publicUrl: "http://localhost",
      issuer: "http://localhost",
      claimPepper: "withdrawal-recovery-test-pepper-32-characters",
    },
  };
}

async function setup(options: ReturnType<typeof optionsFor>) {
  const plane = createControlPlane(options);
  await plane.withdrawalRecovery.firstPass;
  const owner = await verified(plane.app, "withdrawal-restart-owner");
  const member = await provisional(plane.app);
  const org = overlapCast(
    await (
      await createOrg(plane.app, owner.accessToken, "withdrawal-restart")
    ).json(),
  );
  const add = await plane.app.request(`/v1/organizations/${org.id}/members`, {
    method: "POST",
    headers: { ...auth(owner.accessToken), "content-type": "application/json" },
    body: JSON.stringify({ principalId: member.principalId, role: "member" }),
  });
  expect(add.status).toBe(201);
  const remove = () =>
    plane.app.request(
      `/v1/organizations/${org.id}/members/${member.principalId}`,
      {
        method: "DELETE",
        headers: auth(owner.accessToken),
      },
    );
  return { ...plane, owner, member, org, remove };
}

it("retries a persisted Host withdrawal after restart without blocking readiness", async () => {
  const client = await migratedPGlite();
  try {
    const options = optionsFor(drizzle(client, { schema }));
    const first = await setup(options);
    const requests: string[] = [];
    let available = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      requests.push(
        (JSON.parse(String(init?.body)) as { withdrawal_id: string })
          .withdrawal_id,
      );
      return new Response("{}", { status: available ? 200 : 503 });
    });
    expect((await first.remove()).status).toBe(502);
    await first.withdrawalRecovery.stop();
    const restarted = createControlPlane(options);
    await restarted.ctx.securityRecoveryReady;
    await restarted.withdrawalRecovery.firstPass;
    expect((await restarted.app.request("/v1/health/ready")).status).toBe(200);
    expect(
      (
        await restarted.app.request("/v1/principals/me", {
          headers: auth(first.member.accessToken),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await restarted.ctx.stores.organizationMemberships.findVersioned(
          first.org.id,
          first.member.principalId,
        )
      )?.withdrawalId,
    ).toBeDefined();
    available = true;
    await vi.waitFor(
      async () => {
        expect(
          await restarted.ctx.stores.organizationMemberships.find(
            first.org.id,
            first.member.principalId,
          ),
        ).toBeUndefined();
      },
      { timeout: 8_000, interval: 50 },
    );
    await restarted.withdrawalRecovery.stop();
    expect(new Set(requests).size).toBe(1);
    expect(
      await restarted.ctx.stores.provisionalTokens.get(
        first.member.accessToken,
      ),
    ).toBeUndefined();
    const again = createControlPlane(options);
    await again.ctx.securityRecoveryReady;
    await again.withdrawalRecovery.firstPass;
    const audits = await again.ctx.repos.auditEvents.list({ limit: 100 });
    expect(
      audits.filter(
        (event) => event.eventType === "organization.member_removed",
      ),
    ).toHaveLength(1);
    expect(
      audits.filter(
        (event) => event.eventType === "organization.member_revoked",
      ),
    ).toHaveLength(1);
    await again.withdrawalRecovery.stop();
  } finally {
    await client.close();
  }
});

it("recovers an actor audit when removal committed before its audit sink failed", async () => {
  const client = await migratedPGlite();
  try {
    const options = optionsFor(drizzle(client, { schema }));
    const first = await setup(options);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );
    const append = first.ctx.repos.auditEvents.append.bind(
      first.ctx.repos.auditEvents,
    );
    const failing = vi
      .spyOn(first.ctx.repos.auditEvents, "append")
      .mockImplementation(async (event, uow) => {
        if (event.eventType === "organization.member_removed")
          throw new Error("actor audit unavailable");
        return append(event, uow);
      });
    expect((await first.remove()).status).toBe(500);
    await first.withdrawalRecovery.stop();
    expect(
      await first.ctx.stores.organizationMemberships.find(
        first.org.id,
        first.member.principalId,
      ),
    ).toBeUndefined();
    expect(await first.ctx.stores.organizationWithdrawalAudits.size).toBe(1);
    failing.mockRestore();

    const restarted = createControlPlane(options);
    await restarted.ctx.securityRecoveryReady;
    expect(await restarted.ctx.stores.organizationWithdrawalAudits.size).toBe(
      0,
    );
    const audits = await restarted.ctx.repos.auditEvents.list({ limit: 100 });
    const actorEvents = audits.filter(
      (event) => event.eventType === "organization.member_removed",
    );
    expect(actorEvents).toHaveLength(1);
    expect(actorEvents[0]).toMatchObject({
      principalId: first.owner.principalId,
      metadata: {
        action: "organization.member.remove",
        targetId: first.member.principalId,
      },
    });
    await restarted.withdrawalRecovery.stop();
  } finally {
    await client.close();
  }
});
