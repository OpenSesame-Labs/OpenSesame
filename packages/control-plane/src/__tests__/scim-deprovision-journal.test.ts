import { createHash } from "node:crypto";
import type { Organization, ProvisionalSession } from "@opensesame/os-domain";
import { afterEach, expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";
import { saveProvisional } from "../repos/session-storage.js";
import { jitJoinOrganization } from "../routes/organization-membership.js";
import {
  SCIM_DEPROVISION_JOURNAL_ATTRIBUTE,
  deprovisionJournal,
} from "../routes/scim-effects.js";
import { roleForGroupName } from "../routes/scim-groups.js";
import { attachVerifiedExternalIdentity } from "../services/identity-link.js";
import { mockHostWithdrawal } from "./host-withdrawal-test-helper.js";

afterEach(() => vi.restoreAllMocks());

async function fixture(createUser = true) {
  const { app, ctx } = createControlPlane();
  mockHostWithdrawal(ctx);
  const res = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  const session: { principalId: string; accessToken: string } =
    await res.json();
  const issuer = "https://journal-idp.example";
  const subject = "member-subject";
  const now = ctx.clock();
  const organization: Organization = {
    id: "org:journal",
    slug: "journal",
    displayName: "Journal",
    state: "active",
    createdBy: session.principalId,
    createdAt: now,
    updatedAt: now,
    ssoIssuer: issuer,
    provisioningEnabled: true,
  };
  ctx.config.organizationIssuerAllowlist = [`${organization.id}|${issuer}`];
  await ctx.stores.organizations.set(organization.id, organization);
  const membership = {
    organizationId: organization.id,
    principalId: session.principalId,
    role: "member" as const,
    createdAt: now,
    updatedAt: now,
  };
  await ctx.stores.organizationMemberships.upsert(membership);
  expect(
    (
      await attachVerifiedExternalIdentity(ctx, session.principalId, {
        kind: "oidc",
        issuer,
        subject,
        correlationId: "journal-test",
      })
    ).ok,
  ).toBe(true);
  if (createUser)
    await ctx.stores.scim.users.create({
      id: "journal-user",
      organizationId: organization.id,
      userName: subject,
      externalId: subject,
      active: true,
      raw: {},
      createdAt: now,
      updatedAt: now,
    });
  const token = "sct_journal-test";
  await ctx.stores.scim.tokens.mint(
    organization.id,
    createHash("sha256").update(token).digest("hex"),
  );
  const base = `/v1/organizations/${organization.id}/scim/v2/Users`;
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  const patch = (active: boolean) =>
    app.request(`${base}/journal-user`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        Operations: [{ op: "replace", path: "active", value: active }],
      }),
    });
  const del = () =>
    app.request(`${base}/journal-user`, { method: "DELETE", headers });
  const original = [...(await ctx.stores.provisionalSessions.values())].find(
    (item) => item.principalId === session.principalId,
  );
  if (!original) throw new Error("Expected provisional session");
  async function newSession() {
    const fresh: ProvisionalSession = {
      ...original,
      id: `${original.id}-fresh`,
      createdAt: ctx.clock(),
    };
    delete fresh.revokedAt;
    delete fresh.revocationCleanupPending;
    delete fresh.revocationCleanup;
    await saveProvisional(ctx.stores, fresh, "journal-fresh-token");
    return fresh;
  }
  return {
    app,
    ctx,
    organization,
    subject,
    session,
    membership,
    base,
    headers,
    patch,
    del,
    newSession,
  };
}

it("does not revoke a new membership or session on replay, but handles the next deactivation", async () => {
  const f = await fixture();
  expect((await f.del()).status).toBe(204);
  await f.ctx.stores.organizationMemberships.upsert(f.membership);
  const fresh = await f.newSession();
  expect((await f.del()).status).toBe(204);
  expect(
    await f.ctx.stores.organizationMemberships.find(
      f.organization.id,
      f.session.principalId,
    ),
  ).toBeDefined();
  expect(
    (await f.ctx.stores.provisionalSessions.get(fresh.id))?.revokedAt,
  ).toBeUndefined();
  expect((await f.patch(true)).status).toBe(200);
  expect((await f.patch(false)).status).toBe(200);
  expect(
    await f.ctx.stores.organizationMemberships.find(
      f.organization.id,
      f.session.principalId,
    ),
  ).toBeUndefined();
  expect(
    (await f.ctx.stores.provisionalSessions.get(fresh.id))?.revokedAt,
  ).toBeDefined();
});

it("resumes a failed deactivation before reactivation", async () => {
  const f = await fixture();
  const spy = vi
    .spyOn(f.ctx.stores.organizationMemberships, "removeIfIncarnation")
    .mockImplementationOnce(() => {
      throw new Error("injected storage failure");
    });
  expect((await f.del()).status).toBe(500);
  const pending = await f.ctx.stores.scim.users.getById(
    f.organization.id,
    "journal-user",
  );
  expect(pending && deprovisionJournal(pending)?.targets[0]?.completed).toBe(
    false,
  );
  spy.mockRestore();
  expect((await f.patch(true)).status).toBe(200);
  expect(
    await f.ctx.stores.organizationMemberships.find(
      f.organization.id,
      f.session.principalId,
    ),
  ).toBeUndefined();
  expect(
    (await f.ctx.stores.scim.users.getById(f.organization.id, "journal-user"))
      ?.active,
  ).toBe(true);
  expect(
    (
      await f.app.request("/v1/organizations", {
        headers: { authorization: `Bearer ${f.session.accessToken}` },
      })
    ).status,
  ).toBe(401);
});

it("does not resume a stale failed deactivation against a re-created membership", async () => {
  const f = await fixture();
  const spy = vi
    .spyOn(f.ctx.stores.organizationMemberships, "removeIfIncarnation")
    .mockImplementationOnce(() => {
      throw new Error("injected storage failure");
    });
  expect((await f.del()).status).toBe(500);
  spy.mockRestore();
  const pending = await f.ctx.stores.organizationMemberships.findVersioned(
    f.organization.id,
    f.session.principalId,
  );
  if (!pending?.withdrawalId) throw new Error("Expected pending withdrawal");
  expect(
    await f.ctx.stores.organizationMemberships.removeIfIncarnation(
      f.organization.id,
      f.session.principalId,
      pending.incarnation,
      pending.withdrawalId,
    ),
  ).toBe(true);
  await f.ctx.stores.organizationMemberships.upsert(f.membership);
  const fresh = await f.newSession();
  expect((await f.del()).status).toBe(204);
  expect(
    await f.ctx.stores.organizationMemberships.find(
      f.organization.id,
      f.session.principalId,
    ),
  ).toBeDefined();
  expect(
    (await f.ctx.stores.provisionalSessions.get(fresh.id))?.revokedAt,
  ).toBeUndefined();
});

it("serializes a directory deactivation with a competing JIT join", async () => {
  const f = await fixture();
  await f.ctx.stores.organizationMemberships.remove(
    f.organization.id,
    f.session.principalId,
  );
  const original = f.ctx.repos.externalIdentities.findByTuple.bind(
    f.ctx.repos.externalIdentities,
  );
  let reached = () => {};
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let resume = () => {};
  const held = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let first = true;
  const spy = vi
    .spyOn(f.ctx.repos.externalIdentities, "findByTuple")
    .mockImplementation(async (input) => {
      if (first) {
        first = false;
        reached();
        await held;
      }
      return original(input);
    });
  const removing = f.del();
  await entered;
  const joining = jitJoinOrganization(f.ctx, {
    organization: f.organization,
    principalId: f.session.principalId,
    subject: f.subject,
    method: "oidc",
    correlationId: "competing-join",
  });
  resume();
  expect((await removing).status).toBe(204);
  expect(await joining).toMatchObject({ ok: false, error: "not_provisioned" });
  expect(
    await f.ctx.stores.organizationMemberships.find(
      f.organization.id,
      f.session.principalId,
    ),
  ).toBeUndefined();
  spy.mockRestore();
});

it("deprovisions an existing membership when an inactive user is created", async () => {
  const f = await fixture(false);
  const res = await f.app.request(f.base, {
    method: "POST",
    headers: f.headers,
    body: JSON.stringify({
      userName: f.subject,
      externalId: f.subject,
      active: false,
      [SCIM_DEPROVISION_JOURNAL_ATTRIBUTE]: { cycle: "injected", targets: [] },
    }),
  });
  expect(res.status).toBe(201);
  expect(
    (await res.json())[SCIM_DEPROVISION_JOURNAL_ATTRIBUTE],
  ).toBeUndefined();
  expect(
    await f.ctx.stores.organizationMemberships.find(
      f.organization.id,
      f.session.principalId,
    ),
  ).toBeUndefined();
});

it("does not guess membership identity for a legacy inactive row", async () => {
  const f = await fixture();
  const user = await f.ctx.stores.scim.users.getById(
    f.organization.id,
    "journal-user",
  );
  if (!user) throw new Error("Expected user");
  await f.ctx.stores.scim.users.update({ ...user, active: false });
  expect((await f.del()).status).toBe(409);
  expect(
    await f.ctx.stores.organizationMemberships.find(
      f.organization.id,
      f.session.principalId,
    ),
  ).toBeDefined();
  expect((await f.patch(true)).status).toBe(200);
  expect((await f.patch(false)).status).toBe(200);
  expect(
    await f.ctx.stores.organizationMemberships.find(
      f.organization.id,
      f.session.principalId,
    ),
  ).toBeUndefined();
});

it("keeps the journal pending and refuses JIT admission during owner withdrawal", async () => {
  const f = await fixture();
  const current = await f.ctx.stores.organizationMemberships.findVersioned(
    f.organization.id,
    f.session.principalId,
  );
  if (!current) throw new Error("Expected membership");
  const withdrawalId = "5d28036e-3169-42a7-9c0a-2f1a50941e2a";
  expect(
    await f.ctx.stores.organizationMemberships.beginWithdrawal(
      f.organization.id,
      f.session.principalId,
      current.incarnation,
      current.authorityRevision,
      {
        id: withdrawalId,
        kind: "remove",
        actorPrincipalId: f.session.principalId,
        actorType: "human",
        reason: "organization_owner_removed",
        correlationId: "test-withdrawal",
      },
    ),
  ).toBe(true);
  const joined = await jitJoinOrganization(f.ctx, {
    organization: f.organization,
    principalId: f.session.principalId,
    subject: f.subject,
    method: "oidc",
    correlationId: "withdrawing",
  });
  expect(joined).toMatchObject({ ok: false, error: "membership_withdrawing" });
  expect((await f.del()).status).toBeGreaterThanOrEqual(500);
  const inactive = await f.ctx.stores.scim.users.getById(
    f.organization.id,
    "journal-user",
  );
  expect(inactive && deprovisionJournal(inactive)?.targets[0]?.completed).toBe(
    false,
  );
  expect(
    await f.ctx.stores.organizationMemberships.clearWithdrawal(
      f.organization.id,
      f.session.principalId,
      current.incarnation,
      withdrawalId,
    ),
  ).toBe(true);
  expect((await f.del()).status).toBe(204);
  expect(
    await f.ctx.stores.organizationMemberships.find(
      f.organization.id,
      f.session.principalId,
    ),
  ).toBeUndefined();
});

it("uses the current SCIM role rather than an earlier role read by a sign-in", async () => {
  const f = await fixture();
  const result = await jitJoinOrganization(f.ctx, {
    organization: f.organization,
    principalId: f.session.principalId,
    subject: f.subject,
    method: "oidc",
    correlationId: "role-race",
    role: "owner",
  });
  expect(result).toMatchObject({ ok: true, membership: { role: "member" } });
});

it("does not infer roles from directory group names", () => {
  for (const name of [
    "Owners",
    "acme-admins",
    "OpenSesame Members",
    "Engineering",
  ]) {
    expect(roleForGroupName(name)).toBeUndefined();
  }
});
