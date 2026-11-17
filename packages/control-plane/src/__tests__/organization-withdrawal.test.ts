import { createHash } from "node:crypto";
import { overlapCast } from "@opensesame/os-domain";
import { afterEach, expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";
import { boundCookieMatches } from "../middleware/bound-cookie.js";
import { withScimOrganizationBoundary } from "../repos/scim-organization-boundary.js";
import { adoptSessionWithinCapacity } from "../routes/federated-session.js";
import {
  finishOrganizationWithdrawal,
  prepareRemovalWithdrawal,
  prepareRoleWithdrawal,
} from "../services/organization-withdrawal.js";
import {
  auth,
  createOrg,
  provisional,
  testConfig,
  verified,
} from "./organizations-edge.test-support.js";

afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const plane = createControlPlane({ config: testConfig() });
  const { app, ctx } = plane;
  await plane.withdrawalRecovery.firstPass;
  const owner = await verified(app, "withdrawal-owner");
  const member = await provisional(app);
  const org = overlapCast(
    await (
      await createOrg(
        app,
        owner.accessToken,
        `withdrawal-${crypto.randomUUID()}`,
      )
    ).json(),
  );
  const add = () =>
    app.request(`/v1/organizations/${org.id}/members`, {
      method: "POST",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ principalId: member.principalId, role: "member" }),
    });
  expect((await add()).status).toBe(201);
  const patch = (role: string) =>
    app.request(`/v1/organizations/${org.id}/members/${member.principalId}`, {
      method: "PATCH",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ role }),
    });
  const remove = () =>
    app.request(`/v1/organizations/${org.id}/members/${member.principalId}`, {
      method: "DELETE",
      headers: auth(owner.accessToken),
    });
  const approve = (token: string) =>
    app.request("/v1/device/approve", {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ user_code: "ABCD-EFGH", organization_id: org.id }),
    });
  return { ...plane, owner, member, org, add, patch, remove, approve };
}

it("rejects an in-flight old Host approval and admits a re-added incarnation", async () => {
  const f = await fixture();
  let entered = () => {};
  let release = () => {};
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const revoked = new Set<string>();
  let first = true;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      authority_revision: string;
    };
    if (String(url).endsWith("/sessions/revoke")) {
      revoked.add(body.authority_revision);
      return new Response("{}", { status: 200 });
    }
    if (first) {
      first = false;
      entered();
      await gate;
    }
    return new Response("{}", {
      status: revoked.has(body.authority_revision) ? 409 : 200,
    });
  });
  const old = await f.ctx.stores.organizationMemberships.findVersioned(
    f.org.id,
    f.member.principalId,
  );
  const approval = f.approve(f.member.accessToken);
  try {
    await waiting;
    expect((await f.remove()).status).toBe(204);
    expect(
      (
        await f.app.request("/v1/principals/me", {
          headers: auth(f.member.accessToken),
        })
      ).status,
    ).toBe(401);
  } finally {
    release();
  }
  expect((await approval).status).toBe(502);
  expect((await f.add()).status).toBe(201);
  const replacement = await f.ctx.stores.organizationMemberships.findVersioned(
    f.org.id,
    f.member.principalId,
  );
  expect(replacement?.incarnation).not.toBe(old?.incarnation);
  const session = await adoptSessionWithinCapacity(
    f.ctx,
    f.member.principalId,
    "rejoin",
  );
  expect((await f.approve(session.accessToken)).status).toBe(200);
  await f.withdrawalRecovery.stop();
});

it("keeps local sessions fenced through ambiguous Host failures and retries the same revision", async () => {
  const f = await fixture();
  const proof = "f".repeat(64);
  const session = await f.ctx.stores.provisionalSessions.get(
    f.member.sessionId,
  );
  if (!session) throw new Error("Expected provisional session");
  await f.ctx.stores.provisionalSessions.set(f.member.sessionId, {
    ...session,
    restoreProofHash: createHash("sha256").update(proof).digest("hex"),
  });
  expect(await boundCookieMatches(f.ctx, f.member.sessionId, proof)).toBe(true);
  const payloads: Array<{ withdrawal_id: string; authority_revision: string }> =
    [];
  const tombstones = new Set<string>();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      withdrawal_id: string;
      authority_revision: string;
    };
    payloads.push(body);
    if (payloads.length === 1) throw new Error("unreachable before commit");
    tombstones.add(body.authority_revision);
    if (payloads.length === 2) throw new Error("response lost after commit");
    return new Response("{}", { status: 200 });
  });
  const before = await f.ctx.stores.organizationMemberships.findVersioned(
    f.org.id,
    f.member.principalId,
  );
  expect((await f.patch("admin")).status).toBe(502);
  expect(
    (
      await f.app.request("/v1/principals/me", {
        headers: auth(f.member.accessToken),
      })
    ).status,
  ).toBe(401);
  expect(await boundCookieMatches(f.ctx, f.member.sessionId, proof)).toBe(
    false,
  );
  expect((await f.patch("admin")).status).toBe(502);
  expect((await f.patch("admin")).status).toBe(200);
  expect(new Set(payloads.map((payload) => payload.withdrawal_id)).size).toBe(
    1,
  );
  expect(
    new Set(payloads.map((payload) => payload.authority_revision)),
  ).toEqual(new Set([before?.authorityRevision]));
  expect(tombstones.has(before?.authorityRevision ?? "")).toBe(true);
  const after = await f.ctx.stores.organizationMemberships.findVersioned(
    f.org.id,
    f.member.principalId,
  );
  expect(after?.membership.role).toBe("admin");
  expect(after?.incarnation).toBe(before?.incarnation);
  expect(after?.authorityRevision).not.toBe(before?.authorityRevision);
  expect(
    (
      await f.app.request("/v1/principals/me", {
        headers: auth(f.member.accessToken),
      })
    ).status,
  ).toBe(200);
  const audits = await f.ctx.repos.auditEvents.list({ limit: 100 });
  expect(
    audits.filter(
      (event) => event.eventType === "organization.member_role_changed",
    ),
  ).toHaveLength(1);
  await f.withdrawalRecovery.stop();
});

it("does not count a withdrawing owner as the last available owner", async () => {
  const f = await fixture();
  await f.ctx.stores.organizationMemberships.upsert({
    organizationId: f.org.id,
    principalId: f.member.principalId,
    role: "owner",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("unavailable", { status: 503 }),
  );
  expect((await f.patch("member")).status).toBe(502);
  const second = await f.app.request(
    `/v1/organizations/${f.org.id}/members/${f.owner.principalId}`,
    {
      method: "PATCH",
      headers: {
        ...auth(f.owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ role: "member" }),
    },
  );
  expect(second.status).toBe(409);
  expect(overlapCast(await second.json()).error).toBe("last_owner");
  await f.withdrawalRecovery.stop();
});

it("upgrades an in-flight role change to system removal without reviving a re-added member", async () => {
  const f = await fixture();
  const input = {
    organizationId: f.org.id,
    principalId: f.member.principalId,
    actorPrincipalId: f.owner.principalId,
    actorType: "human" as const,
    correlationId: "role-request",
    role: "admin" as const,
  };
  const role = await withScimOrganizationBoundary(f.ctx, f.org.id, (tx) =>
    prepareRoleWithdrawal(tx, input),
  );
  if (role.status !== "ready") throw new Error("Expected role withdrawal");
  let entered = () => {};
  let release = () => {};
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    if (++calls === 1) {
      entered();
      await gate;
    }
    return new Response("{}", { status: 200 });
  });
  const oldFinish = finishOrganizationWithdrawal(f.ctx, role.prepared);
  await waiting;
  const removal = await withScimOrganizationBoundary(f.ctx, f.org.id, (tx) =>
    prepareRemovalWithdrawal(tx, {
      ...input,
      actorType: "system",
      correlationId: "directory-deactivation",
      reason: "scim_deactivated",
    }),
  );
  if (removal.status !== "ready") throw new Error("Expected upgraded removal");
  expect(removal.prepared.withdrawal.id).toBe(role.prepared.withdrawal.id);
  expect(removal.prepared.authorityRevision).toBe(
    role.prepared.authorityRevision,
  );
  expect(
    (await finishOrganizationWithdrawal(f.ctx, removal.prepared)).status,
  ).toBe("removed");
  release();
  expect((await oldFinish).status).toBe("stale");
  expect((await f.add()).status).toBe(201);
  expect(
    (await finishOrganizationWithdrawal(f.ctx, role.prepared)).status,
  ).toBe("stale");
  expect(
    await f.ctx.stores.organizationMemberships.find(
      f.org.id,
      f.member.principalId,
    ),
  ).toBeDefined();
  const audits = await f.ctx.repos.auditEvents.list({ limit: 100 });
  expect(
    audits.filter((event) => event.eventType === "organization.member_removed"),
  ).toHaveLength(1);
  expect(
    audits.filter(
      (event) => event.eventType === "organization.member_role_changed",
    ),
  ).toHaveLength(0);
  await f.withdrawalRecovery.stop();
});
