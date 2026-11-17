import { createHash } from "node:crypto";
import type { Organization } from "@opensesame/os-domain";
import { afterEach, expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";
import { jitJoinOrganization } from "../routes/organization-membership.js";
import { SCIM_ROLE_ATTRIBUTE } from "../routes/scim-effects.js";
import { attachVerifiedExternalIdentity } from "../services/identity-link.js";

afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const { app, ctx } = createControlPlane();
  const response = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  const session: { principalId: string } = await response.json();
  const now = ctx.clock();
  const organization: Organization = {
    id: "org:role-withdrawal",
    slug: "role-withdrawal",
    displayName: "Roles",
    state: "active",
    createdBy: session.principalId,
    createdAt: now,
    updatedAt: now,
    ssoIssuer: "https://role-idp.example",
    provisioningEnabled: true,
  };
  ctx.config.organizationIssuerAllowlist = [
    `${organization.id}|${organization.ssoIssuer}`,
  ];
  await ctx.stores.organizations.set(organization.id, organization);
  await ctx.stores.organizationMemberships.upsert({
    organizationId: organization.id,
    principalId: session.principalId,
    role: "member",
    createdAt: now,
    updatedAt: now,
  });
  expect(
    (
      await attachVerifiedExternalIdentity(ctx, session.principalId, {
        kind: "oidc",
        issuer: organization.ssoIssuer ?? "",
        subject: "alice",
        correlationId: "test-role",
      })
    ).ok,
  ).toBe(true);
  await ctx.stores.scim.users.create({
    id: "alice",
    organizationId: organization.id,
    userName: "alice",
    externalId: "alice",
    active: true,
    raw: {},
    createdAt: now,
    updatedAt: now,
  });
  const requests: Array<{ withdrawal_id: string; authority_revision: string }> =
    [];
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: requests.length === 1 ? 503 : 204 });
    });
  return { app, ctx, session, organization, requests, fetchSpy };
}

it("resumes a failed JIT role withdrawal with the same Host intent", async () => {
  const f = await fixture();
  const user = await f.ctx.stores.scim.users.getById(
    f.organization.id,
    "alice",
  );
  if (!user) throw new Error("Expected user");
  await f.ctx.stores.scim.users.update({
    ...user,
    raw: { [SCIM_ROLE_ATTRIBUTE]: "admin" },
  });
  const before = await f.ctx.stores.organizationMemberships.findVersioned(
    f.organization.id,
    f.session.principalId,
  );
  const input = {
    organization: f.organization,
    principalId: f.session.principalId,
    subject: "alice",
    method: "oidc",
    correlationId: "jit-role",
  };
  expect(await jitJoinOrganization(f.ctx, input)).toMatchObject({
    ok: false,
    error: "membership_withdrawing",
  });
  const pending = await f.ctx.stores.organizationMemberships.findVersioned(
    f.organization.id,
    f.session.principalId,
  );
  expect(pending?.membership.role).toBe("member");
  expect(pending?.withdrawalId).toBeDefined();
  expect(await jitJoinOrganization(f.ctx, input)).toMatchObject({
    ok: true,
    membership: { role: "admin" },
  });
  const completed = await f.ctx.stores.organizationMemberships.findVersioned(
    f.organization.id,
    f.session.principalId,
  );
  expect(completed?.withdrawalId).toBeUndefined();
  expect(completed?.authorityRevision).not.toBe(before?.authorityRevision);
  expect(f.requests).toHaveLength(2);
  expect(f.requests[1]?.withdrawal_id).toBe(f.requests[0]?.withdrawal_id);
  expect(f.requests[1]?.authority_revision).toBe(before?.authorityRevision);
});

it("retries a SCIM group role change after the Host was unavailable", async () => {
  const f = await fixture();
  await f.ctx.stores.scim.mappings.put(f.organization.id, "operators", "admin");
  const token = "sct_group-withdrawal";
  await f.ctx.stores.scim.tokens.mint(
    f.organization.id,
    createHash("sha256").update(token).digest("hex"),
  );
  const patch = () =>
    f.app.request(
      `/v1/organizations/${f.organization.id}/scim/v2/Groups/operators`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          Operations: [
            { op: "add", path: "members", value: [{ value: "alice" }] },
          ],
        }),
      },
    );
  expect((await patch()).status).toBe(500);
  expect(
    (
      await f.ctx.stores.organizationMemberships.findVersioned(
        f.organization.id,
        f.session.principalId,
      )
    )?.membership.role,
  ).toBe("member");
  expect((await patch()).status).toBe(200);
  expect(
    (
      await f.ctx.stores.organizationMemberships.find(
        f.organization.id,
        f.session.principalId,
      )
    )?.role,
  ).toBe("admin");
  expect(f.requests).toHaveLength(2);
  expect(f.requests[1]?.withdrawal_id).toBe(f.requests[0]?.withdrawal_id);
});

it("turns an in-flight role change into removal when SCIM deactivates the user", async () => {
  const f = await fixture();
  const user = await f.ctx.stores.scim.users.getById(
    f.organization.id,
    "alice",
  );
  if (!user) throw new Error("Expected user");
  await f.ctx.stores.scim.users.update({
    ...user,
    raw: { [SCIM_ROLE_ATTRIBUTE]: "admin" },
  });
  const token = "sct_role-upgrade";
  await f.ctx.stores.scim.tokens.mint(
    f.organization.id,
    createHash("sha256").update(token).digest("hex"),
  );
  let entered = () => {};
  let resume = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const requests: Array<{ withdrawal_id: string }> = [];
  f.fetchSpy.mockImplementation(async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    if (requests.length === 1) {
      entered();
      await blocked;
    }
    return new Response(null, { status: 204 });
  });
  const joining = jitJoinOrganization(f.ctx, {
    organization: f.organization,
    principalId: f.session.principalId,
    subject: "alice",
    method: "oidc",
    correlationId: "inflight-role",
  });
  await started;
  const deactivated = await f.app.request(
    `/v1/organizations/${f.organization.id}/scim/v2/Users/alice`,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    },
  );
  resume();
  expect(deactivated.status).toBe(204);
  expect(await joining).toMatchObject({
    ok: false,
    error: "membership_withdrawing",
  });
  expect(requests).toHaveLength(2);
  expect(requests[1]?.withdrawal_id).toBe(requests[0]?.withdrawal_id);
  expect(
    await f.ctx.stores.organizationMemberships.find(
      f.organization.id,
      f.session.principalId,
    ),
  ).toBeUndefined();
  expect(
    (await f.ctx.stores.scim.users.getById(f.organization.id, "alice"))?.active,
  ).toBe(false);
});
