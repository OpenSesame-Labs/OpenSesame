import { auditEventDigest } from "@opensesame/audit";
import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";
import { resumePendingOrganizationWithdrawalAudits } from "../repos/organization-withdrawal-audit.js";
import {
  authenticatedPrincipalId,
  ensurePersonalOrganization,
  hostApiEndpoint,
  revokeOrganizationMembership,
} from "../routes/organizations.js";
import { finishLegacyOrphan } from "../routes/scim-legacy-orphan.js";
import { prepareRemovalWithdrawal } from "../services/organization-withdrawal.js";
import { scheduleOrganizationWithdrawalRecovery } from "../services/organization-withdrawal-recovery.js";
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
  attest = true,
) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const response = await impl(input, init);
      const url = input instanceof Request ? input.url : String(input);
      if (!attest || !response.ok || !url.endsWith("/api/v1/sessions/revoke"))
        return response;
      return hostRevocationResponse(init);
    });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("organization helpers", () => {
  it("retries deferred withdrawal recovery until the pending set clears", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    await ctx.systemPrincipalReady;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const member = await provisional(app);
    const outsider = await provisional(app);
    const [plainMembership] =
      await ctx.stores.organizationMemberships.listByPrincipal(
        member.principalId,
      );
    const membership = plainMembership
      ? await ctx.stores.organizationMemberships.findVersioned(
          plainMembership.organizationId,
          member.principalId,
        )
      : undefined;
    if (!membership) throw new Error("Expected personal membership");
    const prepared = await prepareRemovalWithdrawal(ctx, {
      organizationId: membership.membership.organizationId,
      principalId: member.principalId,
      expectedIncarnation: membership.incarnation,
      actorPrincipalId: ctx.systemOwnerPrincipalId,
      actorType: "system",
      correlationId: "host-retry",
      reason: "scim_deactivated",
    });
    expect(prepared.status).toBe("ready");
    const pendingOwnerMutation = await app.request(
      `/v1/organizations/${membership.membership.organizationId}/members`,
      {
        method: "POST",
        headers: {
          ...auth(member.accessToken),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          principalId: outsider.principalId,
          role: "member",
        }),
      },
    );
    expect(pendingOwnerMutation.status).toBe(404);
    await ctx.stores.organizationWithdrawalAudits.set("audit-retry", {
      id: "audit-retry",
      kind: "remove",
      actorType: "system",
      actorPrincipalId: ctx.systemOwnerPrincipalId,
      organizationId: "org:audit-retry",
      principalId: "prn_audit_retry",
      correlationId: "audit-retry",
      previousRole: "member",
    });
    const audit = vi
      .spyOn(ctx.repos.auditEvents, "append")
      .mockRejectedValue(new Error("audit sink unavailable"));
    const host = mockHostFetch(() =>
      Promise.resolve(new Response("{}", { status: 200 })),
    );
    const pending = vi.spyOn(
      ctx.stores.organizationMemberships,
      "listPendingWithdrawals",
    );
    let retry: (() => void) | undefined;
    const delays: number[] = [];
    scheduleOrganizationWithdrawalRecovery(
      ctx,
      Promise.resolve(),
      () => undefined,
      (run, delayMs) => {
        delays.push(delayMs);
        retry = run;
      },
    );
    for (let expected = 1; expected <= 8; expected += 1) {
      await vi.waitFor(() => expect(pending).toHaveBeenCalledTimes(expected));
      retry?.();
    }
    expect(audit).toHaveBeenCalled();
    audit.mockRestore();
    await vi.waitFor(() => expect(pending).toHaveBeenCalledTimes(9));
    expect(host).toHaveBeenCalledOnce();
    expect(
      await ctx.stores.organizationMemberships.find(
        membership.membership.organizationId,
        member.principalId,
      ),
    ).toBeUndefined();
    expect(delays).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000,
    ]);
  });

  it("authenticatedPrincipalId throws when the middleware contract broke", () => {
    expect(() => authenticatedPrincipalId(undefined)).toThrow(
      /invariant violated/,
    );
    expect(authenticatedPrincipalId("prn_1")).toBe("prn_1");
  });

  it("contacts Host before a legacy-orphan audit can fail", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const member = await provisional(app);
    const fetchSpy = mockHostFetch(() =>
      Promise.resolve(new Response("{}", { status: 200 })),
    );
    vi.spyOn(ctx.repos.auditEvents, "append").mockRejectedValueOnce(
      new Error("audit sink unavailable"),
    );

    await expect(
      finishLegacyOrphan(
        ctx,
        "org:legacy-orphan",
        {
          principalId: member.principalId,
          incarnation: "00000000-0000-4000-8000-000000000010",
          authorityRevision: "00000000-0000-4000-8000-000000000011",
          withdrawalId: "00000000-0000-4000-8000-000000000012",
        },
        "legacy-orphan-audit",
      ),
    ).rejects.toThrow("audit sink unavailable");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("does not remove a membership recreated before legacy-orphan recovery", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const member = await provisional(app);
    const organizationId = "org:legacy-orphan-recreated";
    const now = ctx.clock();
    await ctx.stores.organizationMemberships.upsert({
      organizationId,
      principalId: member.principalId,
      role: "member",
      createdAt: now,
      updatedAt: now,
    });
    const host = mockHostFetch(() =>
      Promise.resolve(new Response("{}", { status: 200 })),
    );

    await finishLegacyOrphan(
      ctx,
      organizationId,
      {
        principalId: member.principalId,
        incarnation: "00000000-0000-4000-8000-000000000020",
        authorityRevision: "00000000-0000-4000-8000-000000000021",
        withdrawalId: "00000000-0000-4000-8000-000000000022",
      },
      "legacy-orphan-recreated",
    );
    expect(
      await ctx.stores.organizationMemberships.find(
        organizationId,
        member.principalId,
      ),
    ).toBeDefined();
    expect(host).not.toHaveBeenCalled();
  });

  it("retains an audit intent when its apparent event is detached", async () => {
    const { ctx } = createControlPlane({ config: testConfig() });
    const id = "00000000-0000-4000-8000-000000000013";
    await ctx.stores.organizationWithdrawalAudits.set(id, {
      id,
      kind: "remove",
      actorType: "system",
      actorPrincipalId: ctx.systemOwnerPrincipalId,
      organizationId: "org:detached-audit",
      principalId: "prn_detached_audit",
      correlationId: "detached-audit",
      previousRole: "member",
    });
    const previousDigest = "a".repeat(64);
    const detached = overlapCast({
      id: `organization-withdrawal:${id}`,
      occurredAt: new Date(),
      eventType: "organization.member_removed",
      outcome: "succeeded",
      actorType: "system",
      principalId: ctx.systemOwnerPrincipalId,
      organizationId: "org:detached-audit",
      correlationId: "detached-audit",
      metadata: {
        action: "organization.member.remove",
        targetId: "prn_detached_audit",
        fromState: "member",
      },
      previousDigest,
    });
    detached.digest = auditEventDigest(detached, previousDigest);
    vi.spyOn(ctx.repos.auditEvents, "getById").mockResolvedValue(detached);

    await expect(
      resumePendingOrganizationWithdrawalAudits(ctx),
    ).rejects.toThrow("Conflicting organization withdrawal audit event");
    expect(await ctx.stores.organizationWithdrawalAudits.get(id)).toBeDefined();
  });

  it("hostApiEndpoint rejects non-HTTP, credentialed, and invalid URLs", () => {
    expect(hostApiEndpoint("https://host.example", "api/v1/x")?.href).toBe(
      "https://host.example/api/v1/x",
    );
    expect(
      hostApiEndpoint("https://host.example/base", "/api/v1/x")?.href,
    ).toBe("https://host.example/base/api/v1/x");
    expect(hostApiEndpoint("ftp://host.example", "api/v1/x")).toBeUndefined();
    expect(
      hostApiEndpoint("https://user:pass@host.example", "api/v1/x"),
    ).toBeUndefined();
    expect(hostApiEndpoint("not a url", "api/v1/x")).toBeUndefined();
  });

  it("ensurePersonalOrganization is idempotent", async () => {
    const { ctx } = createControlPlane({ config: testConfig() });
    const first = await ensurePersonalOrganization(ctx, "prn_1");
    const second = await ensurePersonalOrganization(ctx, "prn_1");
    expect(second.organizationId).toBe(first.organizationId);
    // Use the store contract so this assertion also holds against Postgres.
    expect(await ctx.stores.organizations.listByCreator("prn_1")).toHaveLength(
      1,
    );
  });

  it("revokeOrganizationMembership drops organization authority without global logout", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const member = await provisional(app);
    const membership = await ensurePersonalOrganization(
      ctx,
      member.principalId,
    );

    const before = await app.request("/v1/principals/me", {
      headers: auth(member.accessToken),
    });
    expect(before.status).toBe(200);

    const result = await revokeOrganizationMembership(ctx, {
      organizationId: membership.organizationId,
      principalId: member.principalId,
      correlationId: "corr-revoke",
      reason: "deprovisioned",
      withdrawalAudit: {
        id: "00000000-0000-4000-8000-000000000001",
        kind: "remove",
        actorType: "system",
        actorPrincipalId: ctx.systemOwnerPrincipalId,
        organizationId: membership.organizationId,
        principalId: member.principalId,
        correlationId: "corr-revoke",
        previousRole: membership.role,
      },
    });
    expect(result.membershipRemoved).toBe(true);
    expect(
      await ctx.stores.organizationWithdrawalAudits.get(
        "00000000-0000-4000-8000-000000000001",
      ),
    ).toBeDefined();
    const auditFailure = vi
      .spyOn(ctx.repos.auditEvents, "append")
      .mockRejectedValueOnce(new Error("audit store unavailable"));
    await expect(
      resumePendingOrganizationWithdrawalAudits(ctx),
    ).rejects.toThrow("audit store unavailable");
    expect(
      await ctx.stores.organizationWithdrawalAudits.get(
        "00000000-0000-4000-8000-000000000001",
      ),
    ).toBeDefined();
    auditFailure.mockRestore();
    await resumePendingOrganizationWithdrawalAudits(ctx);
    expect(
      await ctx.stores.organizationWithdrawalAudits.get(
        "00000000-0000-4000-8000-000000000001",
      ),
    ).toBeUndefined();

    expect(
      await ctx.stores.organizationMemberships.find(
        membership.organizationId,
        member.principalId,
      ),
    ).toBeUndefined();
    const after = await app.request("/v1/principals/me", {
      headers: auth(member.accessToken),
    });
    expect(after.status).toBe(200);

    // Directory sync may replay a departure; revocation is idempotent.
    const again = await revokeOrganizationMembership(ctx, {
      organizationId: membership.organizationId,
      principalId: member.principalId,
      correlationId: "corr-revoke-2",
      reason: "deprovisioned",
    });
    expect(again.membershipRemoved).toBe(false);
  });
});

describe("organizations routes edge cases", () => {
  it("gates creation on assurance, validation, and slug uniqueness", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const anon = await provisional(app);

    const lowAssurance = await createOrg(app, anon.accessToken, "anon-org");
    expect(lowAssurance.status).toBe(403);
    expect(overlapCast(await lowAssurance.json()).error).toBe(
      "assurance_too_low",
    );

    const owner = await verified(app, "org-create-owner");
    const invalid = await app.request("/v1/organizations", {
      method: "POST",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ slug: "BAD SLUG", displayName: "Nope" }),
    });
    expect(invalid.status).toBe(400);

    expect((await createOrg(app, owner.accessToken, "acme")).status).toBe(201);
    const dupe = await createOrg(app, owner.accessToken, "acme");
    expect(dupe.status).toBe(409);
    expect(overlapCast(await dupe.json()).error).toBe("slug_taken");
  });

  it("reads hide deleted and foreign organizations", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const owner = await verified(app, "org-read-owner");
    const outsider = await verified(app, "org-read-outsider");

    const created = await createOrg(app, owner.accessToken, "readable");
    const org = overlapCast(await created.json());

    expect(
      (
        await app.request(`/v1/organizations/${org.id}`, {
          headers: auth(owner.accessToken),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(`/v1/organizations/${org.id}`, {
          headers: auth(outsider.accessToken),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request("/v1/organizations/org:missing", {
          headers: auth(owner.accessToken),
        })
      ).status,
    ).toBe(404);

    // A deleted org disappears from reads and lists.
    const stored = await ctx.stores.organizations.get(org.id);
    if (!stored) throw new Error("org missing");
    await ctx.stores.organizations.set(org.id, {
      ...stored,
      state: "deleted",
    });
    expect(
      (
        await app.request(`/v1/organizations/${org.id}`, {
          headers: auth(owner.accessToken),
        })
      ).status,
    ).toBe(404);
    const list = await app.request("/v1/organizations", {
      headers: auth(owner.accessToken),
    });
    const ids = overlapCast(await list.json()).organizations.map((o) => o.id);
    expect(ids).not.toContain(org.id);
  });

  it("lists members only for owners", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await verified(app, "org-members-owner");
    const member = await provisional(app);
    const outsider = await provisional(app);

    const org = overlapCast(
      await (await createOrg(app, owner.accessToken, "members-org")).json(),
    );

    expect(
      (
        await app.request(`/v1/organizations/${org.id}/members`, {
          headers: auth(outsider.accessToken),
        })
      ).status,
    ).toBe(404);

    const addMember = await app.request(`/v1/organizations/${org.id}/members`, {
      method: "POST",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ principalId: member.principalId, role: "member" }),
    });
    expect(addMember.status).toBe(201);

    const asMember = await app.request(`/v1/organizations/${org.id}/members`, {
      headers: auth(member.accessToken),
    });
    expect(asMember.status).toBe(403);
    expect(overlapCast(await asMember.json()).error).toBe("owner_required");

    const asOwner = await app.request(`/v1/organizations/${org.id}/members`, {
      headers: auth(owner.accessToken),
    });
    expect(asOwner.status).toBe(200);
    expect(overlapCast(await asOwner.json()).members).toHaveLength(2);
  });

  it.each(["suspended", "deleted"] as const)(
    "retires member-management authority when the organization is %s",
    async (state) => {
      const { app, ctx } = createControlPlane({ config: testConfig() });
      const owner = await verified(app, `org-inactive-owner-${state}`);
      const target = await provisional(app);
      const org = overlapCast(
        await (
          await createOrg(app, owner.accessToken, `inactive-members-${state}`)
        ).json(),
      );
      const stored = await ctx.stores.organizations.get(String(org.id));
      if (!stored) throw new Error("organization missing");
      await ctx.stores.organizations.set(stored.id, {
        ...stored,
        state,
        updatedAt: new Date(),
      });

      expect(
        (
          await app.request(`/v1/organizations/${org.id}/members`, {
            headers: auth(owner.accessToken),
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await app.request(`/v1/organizations/${org.id}/members`, {
            method: "POST",
            headers: {
              ...auth(owner.accessToken),
              "content-type": "application/json",
            },
            body: JSON.stringify({
              principalId: target.principalId,
              role: "member",
            }),
          })
        ).status,
      ).toBe(404);
    },
  );

  it("fences member addition by role and principal state", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const owner = await verified(app, "org-add-owner");
    const member = await provisional(app);
    const third = await provisional(app);
    const outsider = await provisional(app);

    const org = overlapCast(
      await (await createOrg(app, owner.accessToken, "add-org")).json(),
    );
    const add = (token: string, body: BoundaryValue) =>
      app.request(`/v1/organizations/${org.id}/members`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    expect(
      (
        await add(outsider.accessToken, {
          principalId: third.principalId,
          role: "member",
        })
      ).status,
    ).toBe(404);
    expect(
      (await add(owner.accessToken, { principalId: third.principalId })).status,
    ).toBe(400);
    expect(
      (
        await add(owner.accessToken, {
          principalId: "prn_missing",
          role: "member",
        })
      ).status,
    ).toBe(404);

    const suspendedRecord = await ctx.repos.principals.getById(
      third.principalId,
    );
    if (!suspendedRecord) throw new Error("principal missing");
    await ctx.repos.principals.update(
      third.principalId,
      { state: "suspended" },
      suspendedRecord.version,
    );
    const inactive = await add(owner.accessToken, {
      principalId: third.principalId,
      role: "member",
    });
    expect(inactive.status).toBe(409);
    expect(overlapCast(await inactive.json()).error).toBe("principal_inactive");

    expect(
      (
        await add(owner.accessToken, {
          principalId: member.principalId,
          role: "member",
        })
      ).status,
    ).toBe(201);
    const dupe = await add(owner.accessToken, {
      principalId: member.principalId,
      role: "member",
    });
    expect(dupe.status).toBe(409);
    expect(overlapCast(await dupe.json()).error).toBe("membership_exists");

    // A plain member cannot add anyone.
    expect(
      (
        await add(member.accessToken, {
          principalId: outsider.principalId,
          role: "member",
        })
      ).status,
    ).toBe(403);
  });

  it("changes roles only through the owner and rolls back when Host fails", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await verified(app, "org-role-owner");
    const member = await provisional(app);

    const org = overlapCast(
      await (await createOrg(app, owner.accessToken, "role-org")).json(),
    );
    await app.request(`/v1/organizations/${org.id}/members`, {
      method: "POST",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ principalId: member.principalId, role: "member" }),
    });

    const change = (
      token: string,
      target: string,
      body: BoundaryValue,
      orgId = org.id,
    ) =>
      app.request(`/v1/organizations/${orgId}/members/${target}`, {
        method: "PATCH",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    expect(
      (
        await change(
          owner.accessToken,
          member.principalId,
          { role: "admin" },
          "org:missing",
        )
      ).status,
    ).toBe(404);
    expect(
      (await change(member.accessToken, member.principalId, { role: "admin" }))
        .status,
    ).toBe(403);
    expect(
      (await change(owner.accessToken, "prn_missing", { role: "admin" }))
        .status,
    ).toBe(404);
    expect(
      (await change(owner.accessToken, member.principalId, {})).status,
    ).toBe(400);

    // No-op change answers with the current membership without calling Host.
    const fetchSpy = mockHostFetch(() =>
      Promise.resolve(new Response("{}", { status: 200 })),
    );
    const noop = await change(owner.accessToken, member.principalId, {
      role: "member",
    });
    expect(noop.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();

    // The last owner cannot be demoted.
    const lastOwner = await change(owner.accessToken, owner.principalId, {
      role: "member",
    });
    expect(lastOwner.status).toBe(409);
    expect(overlapCast(await lastOwner.json()).error).toBe("last_owner");

    // Host acknowledgement gates the change.
    const promoted = await change(owner.accessToken, member.principalId, {
      role: "admin",
    });
    expect(promoted.status).toBe(200);
    expect(overlapCast(await promoted.json()).role).toBe("admin");

    // Host failure restores the previous role.
    fetchSpy.mockResolvedValue(new Response("nope", { status: 500 }));
    const failed = await change(owner.accessToken, member.principalId, {
      role: "member",
    });
    expect(failed.status).toBe(502);
    expect(overlapCast(await failed.json()).error).toBe(
      "session_revocation_failed",
    );
    const members = await app.request(`/v1/organizations/${org.id}/members`, {
      headers: auth(owner.accessToken),
    });
    const rows = overlapCast(await members.json()).members;
    expect(rows.find((m) => m.principalId === member.principalId)?.role).toBe(
      "admin",
    );

    // An unreachable Host rolls back the same way.
    fetchSpy.mockRejectedValue(new Error("connection refused"));
    const unreachable = await change(owner.accessToken, member.principalId, {
      role: "member",
    });
    expect(unreachable.status).toBe(502);
  });

  it("removes members with owner and last-owner fences and Host rollback", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await verified(app, "org-remove-owner");
    const member = await provisional(app);
    const outsider = await provisional(app);

    const org = overlapCast(
      await (await createOrg(app, owner.accessToken, "remove-org")).json(),
    );
    await app.request(`/v1/organizations/${org.id}/members`, {
      method: "POST",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ principalId: member.principalId, role: "member" }),
    });

    const remove = (token: string, target: string, orgId = org.id) =>
      app.request(`/v1/organizations/${orgId}/members/${target}`, {
        method: "DELETE",
        headers: auth(token),
      });

    expect(
      (await remove(owner.accessToken, member.principalId, "org:missing"))
        .status,
    ).toBe(404);
    expect(
      (await remove(outsider.accessToken, member.principalId)).status,
    ).toBe(404);
    expect((await remove(member.accessToken, owner.principalId)).status).toBe(
      403,
    );
    expect((await remove(owner.accessToken, "prn_missing")).status).toBe(404);

    const lastOwner = await remove(owner.accessToken, owner.principalId);
    expect(lastOwner.status).toBe(409);
    expect(overlapCast(await lastOwner.json()).error).toBe("last_owner");

    // Host failure keeps the membership in place.
    const fetchSpy = mockHostFetch(() =>
      Promise.resolve(new Response("nope", { status: 500 })),
    );
    const failed = await remove(owner.accessToken, member.principalId);
    expect(failed.status).toBe(502);
    expect(
      (
        await app.request(`/v1/organizations/${org.id}/members`, {
          headers: auth(owner.accessToken),
        })
      ).status,
    ).toBe(200);

    fetchSpy.mockResolvedValue(new Response('{"revoked":1}', { status: 200 }));
    const legacy = await remove(owner.accessToken, member.principalId);
    expect(legacy.status).toBe(502);
    expect(overlapCast(await legacy.json()).error).toBe(
      "session_revocation_failed",
    );

    fetchSpy.mockImplementation(async (_input, init) =>
      hostRevocationResponse(init),
    );
    expect((await remove(owner.accessToken, member.principalId)).status).toBe(
      204,
    );
    const after = await app.request(`/v1/organizations/${org.id}/members`, {
      headers: auth(owner.accessToken),
    });
    expect(overlapCast(await after.json()).members).toHaveLength(1);
  });
});
