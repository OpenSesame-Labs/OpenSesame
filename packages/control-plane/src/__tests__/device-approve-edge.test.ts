import { overlapCast } from "@opensesame/os-domain";
import { afterEach, describe, expect, vi } from "vitest";
import { createControlPlane } from "../create-app.js";
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
