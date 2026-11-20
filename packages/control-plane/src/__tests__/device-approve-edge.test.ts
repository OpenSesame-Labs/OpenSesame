import { overlapCast } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";
import { withScimOrganizationBoundary } from "../repos/scim-organization-boundary.js";
import { prepareRemovalWithdrawal } from "../services/organization-withdrawal.js";
import {
  auth,
  createOrg,
  provisional,
  baseTestConfig as testConfig,
  verified,
} from "./organization-tenant-fixture.js";
import { hostRevocationResponse } from "./scim-test-helpers.js";

function mockHostFetch(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const response = await impl(input, init);
      const url = input instanceof Request ? input.url : String(input);
      return response.ok && url.endsWith("/api/v1/sessions/revoke")
        ? hostRevocationResponse(init)
        : response;
    });
}

afterEach(() => vi.restoreAllMocks());

describe("device approve edge cases", () => {
  it("requires a configured operator token", async () => {
    const { app } = createControlPlane({
      config: { ...testConfig(), operatorToken: "" },
    });
    const created = await provisional(app);
    const res = await app.request("/v1/device/approve", {
      method: "POST",
      headers: {
        ...auth(created.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ user_code: "ABCD-EFGH" }),
    });
    expect(res.status).toBe(503);
    expect(overlapCast(await res.json()).error).toBe(
      "operator_token_unconfigured",
    );
  });

  it("requires a user_code in a JSON object body", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const created = await provisional(app);

    const notJson = await app.request("/v1/device/approve", {
      method: "POST",
      headers: {
        ...auth(created.accessToken),
        "content-type": "application/json",
      },
      body: "not json at all{",
    });
    expect(notJson.status).toBe(400);

    const missing = await app.request("/v1/device/approve", {
      method: "POST",
      headers: {
        ...auth(created.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ user_code: "   " }),
    });
    expect(missing.status).toBe(400);
    expect(overlapCast(await missing.json()).error).toBe("invalid_request");
  });

  it("requires disambiguation when the principal holds several memberships", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await verified(app, "device-multi-org");
    // Personal workspace plus one created organization.
    expect((await createOrg(app, owner.accessToken, "second-org")).status).toBe(
      201,
    );

    const res = await app.request("/v1/device/approve", {
      method: "POST",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ user_code: "ABCD-EFGH" }),
    });
    expect(res.status).toBe(400);
    expect(overlapCast(await res.json()).error).toBe(
      "organization_id_required",
    );
  });

  it("denies approval into organizations the caller cannot use", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const owner = await verified(app, "device-deny-owner");
    const other = await verified(app, "device-deny-other");
    const foreignOrg = overlapCast(
      await (await createOrg(app, other.accessToken, "foreign-org")).json(),
    );

    // Not a member.
    const notMember = await app.request("/v1/device/approve", {
      method: "POST",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        user_code: "ABCD-EFGH",
        organization_id: foreignOrg.id,
      }),
    });
    expect(notMember.status).toBe(403);
    expect(overlapCast(await notMember.json()).error).toBe(
      "organization_access_denied",
    );

    // A suspended organization denies even its owner.
    const stored = await ctx.stores.organizations.get(foreignOrg.id);
    if (!stored) throw new Error("org missing");
    await ctx.stores.organizations.set(foreignOrg.id, {
      ...stored,
      state: "suspended",
    });
    const suspendedOrg = await app.request("/v1/device/approve", {
      method: "POST",
      headers: {
        ...auth(other.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        user_code: "ABCD-EFGH",
        organization_id: foreignOrg.id,
      }),
    });
    expect(suspendedOrg.status).toBe(403);
  });

  it("sends the authoritative membership revision to the strict Host endpoint", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const member = await provisional(app);
    const memberships =
      await ctx.stores.organizationMemberships.listByPrincipal(
        member.principalId,
      );
    const organizationId = memberships[0]?.organizationId;
    if (!organizationId) throw new Error("personal organization missing");
    const revision = await ctx.stores.organizationMemberships.findVersioned(
      organizationId,
      member.principalId,
    );
    if (!revision) throw new Error("membership revision missing");
    const host = mockHostFetch(async () => new Response("{}", { status: 200 }));

    const response = await app.request("/v1/device/approve", {
      method: "POST",
      headers: {
        ...auth(member.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        user_code: "ABCD-EFGH",
        organization_id: organizationId,
        organization_role: "admin",
        membership_incarnation: "client-supplied",
        authority_revision: "client-supplied",
      }),
    });
    expect(response.status).toBe(200);
    expect(host).toHaveBeenCalledTimes(1);
    const [url, init] = host.mock.calls[0] ?? [];
    expect(String(url)).toMatch(/\/api\/v1\/device\/approve-membership$/);
    expect(JSON.parse(String(init?.body))).toMatchObject({
      principal: member.principalId,
      organization_id: organizationId,
      organization_role: revision.membership.role,
      membership_incarnation: revision.incarnation,
      authority_revision: revision.authorityRevision,
    });
  });

  it("does not approve a membership whose withdrawal is pending", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const member = await provisional(app);
    const memberships =
      await ctx.stores.organizationMemberships.listByPrincipal(
        member.principalId,
      );
    const organizationId = memberships[0]?.organizationId;
    if (!organizationId) throw new Error("personal organization missing");
    const prepared = await withScimOrganizationBoundary(
      ctx,
      organizationId,
      (tx) =>
        prepareRemovalWithdrawal(tx, {
          organizationId,
          principalId: member.principalId,
          actorPrincipalId: ctx.systemOwnerPrincipalId,
          actorType: "system",
          correlationId: "pending-device-approval",
          reason: "scim_deactivated",
        }),
    );
    expect(prepared.status).toBe("ready");
    const host = mockHostFetch(async () => new Response("{}", { status: 200 }));
    const response = await app.request("/v1/device/approve", {
      method: "POST",
      headers: {
        ...auth(member.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        user_code: "ABCD-EFGH",
        organization_id: organizationId,
      }),
    });
    expect(response.status).toBe(403);
    expect(host).not.toHaveBeenCalled();
  });

  it("orders an in-flight Host approval before a withdrawal is prepared", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const member = await provisional(app);
    const memberships =
      await ctx.stores.organizationMemberships.listByPrincipal(
        member.principalId,
      );
    const organizationId = memberships[0]?.organizationId;
    if (!organizationId) throw new Error("personal organization missing");
    let reachedHost = () => {};
    let releaseHost = () => {};
    const entered = new Promise<void>((resolve) => {
      reachedHost = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseHost = resolve;
    });
    const order: string[] = [];
    mockHostFetch(async () => {
      order.push("approval-started");
      reachedHost();
      await gate;
      order.push("approval-finished");
      return new Response("{}", { status: 200 });
    });
    const approval = app.request("/v1/device/approve", {
      method: "POST",
      headers: {
        ...auth(member.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        user_code: "ABCD-EFGH",
        organization_id: organizationId,
      }),
    });
    await entered;
    const withdrawal = withScimOrganizationBoundary(
      ctx,
      organizationId,
      (tx) => {
        order.push("withdrawal-prepared");
        return prepareRemovalWithdrawal(tx, {
          organizationId,
          principalId: member.principalId,
          actorPrincipalId: ctx.systemOwnerPrincipalId,
          actorType: "system",
          correlationId: "approval-overlap",
          reason: "scim_deactivated",
        });
      },
    );
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(order).toEqual(["approval-started"]);
    } finally {
      releaseHost();
    }
    expect((await approval).status).toBe(200);
    expect((await withdrawal).status).toBe("ready");
    expect(order).toEqual([
      "approval-started",
      "approval-finished",
      "withdrawal-prepared",
    ]);
  });

  it("never falls back to the legacy endpoint when an old Host returns 404", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const member = await provisional(app);
    const host = mockHostFetch(async (input) => {
      const pathname = new URL(String(input)).pathname;
      // An older Host would accept the old endpoint and ignore extra fields.
      return new Response("", {
        status: pathname.endsWith("/approve") ? 200 : 404,
      });
    });
    const response = await app.request("/v1/device/approve", {
      method: "POST",
      headers: {
        ...auth(member.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ user_code: "ABCD-EFGH" }),
    });
    expect(response.status).toBe(404);
    expect(host).toHaveBeenCalledTimes(1);
    expect(String(host.mock.calls[0]?.[0])).toMatch(/\/approve-membership$/);
  });

  it("maps Host failures to statuses and keeps the operator token server-side", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    // A fresh principal per probe: the per-principal device throttle is
    // deliberately lower than the Host's deployment-global failure fence.
    const approve = async () => {
      const owner = await provisional(app);
      return app.request("/v1/device/approve", {
        method: "POST",
        headers: {
          ...auth(owner.accessToken),
          "content-type": "application/json",
        },
        body: JSON.stringify({ user_code: "ABCD-EFGH" }),
      });
    };

    const fetchSpy = mockHostFetch(() =>
      Promise.resolve(new Response("gone", { status: 404 })),
    );
    const notFound = await approve();
    expect(notFound.status).toBe(404);
    expect(overlapCast(await notFound.json()).error).toBe(
      "host_approval_failed",
    );
    fetchSpy.mockResolvedValue(new Response("boom", { status: 500 }));
    const badGateway = await approve();
    expect(badGateway.status).toBe(502);
    expect(overlapCast(await badGateway.json()).error).toBe(
      "host_approval_failed",
    );

    fetchSpy.mockRejectedValue(new Error("connection refused"));
    const unreachable = await approve();
    expect(unreachable.status).toBe(502);
    expect(overlapCast(await unreachable.json()).error).toBe(
      "host_api_unreachable",
    );

    // Host bodies are never consumed or reflected, including secret-shaped text.
    fetchSpy.mockResolvedValue(
      new Response("secret-sentinel", { status: 200 }),
    );
    const plain = await approve();
    expect(plain.status).toBe(200);
    expect(await plain.json()).toEqual({ ok: true, status: 200 });
  });

  it("fails closed when the Host API URL is not a plain HTTP(S) base", async () => {
    expect(() =>
      createControlPlane({
        config: { ...testConfig(), hostApiUrl: "ftp://host.example" },
      }),
    ).toThrow(/Invalid deployment endpoint/);
  });
});
