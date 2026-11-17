import { overlapCast } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";
import { revokeProvisionalSession } from "../repos/provisional-revocation.js";
import { adoptSessionWithinCapacity } from "../routes/federated-session.js";
import {
  authenticatedPrincipalId,
  ensurePersonalOrganization,
  hostApiEndpoint,
  revokeOrganizationMembership,
} from "../routes/organizations.js";

import {
  auth,
  provisional,
  testConfig,
} from "./organizations-edge.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("organization helpers", () => {
  it("authenticatedPrincipalId throws when the middleware contract broke", () => {
    expect(() => authenticatedPrincipalId(undefined)).toThrow(
      /invariant violated/,
    );
    expect(authenticatedPrincipalId("prn_1")).toBe("prn_1");
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

  it("revokeOrganizationMembership drops the row and every session it authorized", async () => {
    // The shared deprovisioning helper: SCIM deactivation and an LDAP sync
    // both land here, and a revocation that removed the membership but left
    // live bearers behind would leave the user signed in regardless.
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
    });
    expect(result.membershipRemoved).toBe(true);
    expect(result.sessionsRevoked).toBeGreaterThan(0);

    expect(
      await ctx.stores.organizationMemberships.find(
        membership.organizationId,
        member.principalId,
      ),
    ).toBeUndefined();
    const after = await app.request("/v1/principals/me", {
      headers: auth(member.accessToken),
    });
    expect(after.status).toBe(401);

    // Directory sync may replay a departure; revocation is idempotent.
    const again = await revokeOrganizationMembership(ctx, {
      organizationId: membership.organizationId,
      principalId: member.principalId,
      correlationId: "corr-revoke-2",
      reason: "deprovisioned",
    });
    expect(again.membershipRemoved).toBe(false);
    expect(again.sessionsRevoked).toBe(0);
  });

  it("marks every member session revoked before cleanup can fail", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const member = await provisional(app);
    const membership = await ensurePersonalOrganization(
      ctx,
      member.principalId,
    );
    const original = [...(await ctx.stores.provisionalSessions.entries())]
      .map(([, session]) => session)
      .find((session) => session.principalId === member.principalId);
    if (!original) throw new Error("Missing member session");
    const secondId = `${original.id}-second`;
    const secondToken = "second-session-token";
    await ctx.stores.provisionalSessions.set(secondId, {
      ...original,
      id: secondId,
    });
    await ctx.stores.provisionalTokens.set(secondToken, secondId);
    vi.spyOn(ctx.repos.auditEvents, "append").mockRejectedValueOnce(
      new Error("audit unavailable"),
    );

    await expect(
      revokeOrganizationMembership(ctx, {
        organizationId: membership.organizationId,
        principalId: member.principalId,
        correlationId: "corr-batch-failure",
        reason: "deprovisioned",
      }),
    ).rejects.toThrow("audit unavailable");

    expect(
      (await ctx.stores.provisionalSessions.get(original.id))?.revokedAt,
    ).toBeDefined();
    expect(
      (await ctx.stores.provisionalSessions.get(secondId))?.revokedAt,
    ).toBeDefined();
    expect(
      (
        await app.request("/v1/principals/me", {
          headers: auth(member.accessToken),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request("/v1/principals/me", {
          headers: auth(secondToken),
        })
      ).status,
    ).toBe(401);
  });

  it("revokes a session published before a waiting deprovision completes", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const member = await provisional(app);
    const membership = await ensurePersonalOrganization(
      ctx,
      member.principalId,
    );
    const sessions = ctx.stores.provisionalSessions;
    if (!(sessions instanceof Map)) throw new Error("Expected memory store");
    const set = sessions.set.bind(sessions);
    let release = () => {};
    let reached = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    vi.spyOn(sessions, "set").mockImplementationOnce(
      overlapCast(
        async (
          id: string,
          session: typeof sessions extends Map<string, infer S> ? S : never,
        ) => {
          reached();
          await gate;
          return set(id, session);
        },
      ),
    );
    const adoption = adoptSessionWithinCapacity(
      ctx,
      member.principalId,
      "corr-concurrent-adoption",
    );
    await paused;
    const deprovision = revokeOrganizationMembership(ctx, {
      organizationId: membership.organizationId,
      principalId: member.principalId,
      correlationId: "corr-concurrent-deprovision",
      reason: "deprovisioned",
    });
    release();
    const adopted = await adoption;
    await deprovision;
    expect(
      (
        await app.request("/v1/principals/me", {
          headers: auth(adopted.accessToken),
        })
      ).status,
    ).toBe(401);
    const live = [...(await sessions.entries())]
      .map(([, session]) => session)
      .filter(
        (session) =>
          session.principalId === member.principalId && !session.revokedAt,
      );
    expect(live).toEqual([]);
  });

  it("refuses a publication started after the deprovision snapshot", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const member = await provisional(app);
    const membership = await ensurePersonalOrganization(
      ctx,
      member.principalId,
    );
    const sessions = ctx.stores.provisionalSessions;
    if (!(sessions instanceof Map)) throw new Error("Expected memory store");
    const values = sessions.values.bind(sessions);
    let release = () => {};
    let reached = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    vi.spyOn(sessions, "values").mockImplementationOnce(
      overlapCast(async () => {
        reached();
        await gate;
        return values();
      }),
    );

    const deprovision = revokeOrganizationMembership(ctx, {
      organizationId: membership.organizationId,
      principalId: member.principalId,
      correlationId: "corr-snapshot-deprovision",
      reason: "deprovisioned",
    });
    await paused;
    const adoption = expect(
      adoptSessionWithinCapacity(
        ctx,
        member.principalId,
        "corr-after-snapshot-adoption",
      ),
    ).rejects.toThrow(/epoch/i);
    await adoption;
    release();
    await deprovision;

    const live = [...(await sessions.entries())]
      .map(([, session]) => session)
      .filter(
        (session) =>
          session.principalId === member.principalId && !session.revokedAt,
      );
    expect(live).toEqual([]);
  });

  it("does not reopen a completed human revocation during deprovisioning", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const member = await provisional(app);
    const membership = await ensurePersonalOrganization(
      ctx,
      member.principalId,
    );
    const session = [...(await ctx.stores.provisionalSessions.entries())]
      .map(([, value]) => value)
      .find((value) => value.principalId === member.principalId);
    if (!session) throw new Error("Missing member session");
    await revokeProvisionalSession(ctx, session.id, {
      actorType: "human",
      correlationId: "corr-human-signout",
      metadata: { action: "principal.provisional_revoke" },
    });

    await expect(
      revokeOrganizationMembership(ctx, {
        organizationId: membership.organizationId,
        principalId: member.principalId,
        correlationId: "corr-deprovision-after-signout",
        reason: "deprovisioned",
      }),
    ).resolves.toMatchObject({ membershipRemoved: true, sessionsRevoked: 0 });
    expect(
      (await ctx.stores.provisionalSessions.get(session.id))
        ?.revocationCleanupPending,
    ).toBeUndefined();
    expect((await provisional(app)).accessToken).toBeTypeOf("string");
  });
});
