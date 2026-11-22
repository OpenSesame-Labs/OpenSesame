import { createHash } from "node:crypto";
import { PostgresRepositories } from "@opensesame/database";
import * as schema from "@opensesame/database/schema";
import { overlapCast } from "@opensesame/os-domain";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";
import { boundCookieMatches } from "../middleware/bound-cookie.js";
import { beginProvisionalRevocation } from "../repos/provisional-revocation.js";
import { migratedPGlite, warmMigratedPGlite } from "./migrated-pglite.js";

vi.setConfig({ testTimeout: 60_000 });
beforeAll(warmMigratedPGlite, 60_000);

type ControlPlane = ReturnType<typeof createControlPlane>;

async function mint(plane: ControlPlane) {
  const response = await plane.app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(response.status).toBe(201);
  const result: {
    principalId: string;
    sessionId: string;
    accessToken: string;
  } = overlapCast(await response.json());
  return result;
}

function optionsFor(db: ReturnType<typeof drizzle<typeof schema>>) {
  return {
    database: overlapCast(db),
    config: {
      port: 0,
      publicUrl: "http://localhost",
      issuer: "http://localhost",
      claimPepper: "replica-test-only-claim-pepper-32chars",
    },
  };
}

it("recovers upstream logouts before pending session cleanup on restart", async () => {
  const client = await migratedPGlite();
  try {
    const options = optionsFor(drizzle(client, { schema }));
    const first = createControlPlane(options);
    await first.ctx.securityRecoveryReady;
    const pending = await mint(first);
    const upstream = await mint(first);
    await beginProvisionalRevocation(first.ctx, pending.sessionId, {
      actorType: "system",
      correlationId: "startup-pending-cleanup",
    });
    const operationKey = `oidc-logout:${"b".repeat(64)}`;
    await first.ctx.stores.upstreamLogoutOperations.set(operationKey, {
      operationKey,
      issuer: "https://issuer.example",
      subject: "subject",
      sessionIds: [upstream.sessionId],
      sessionsRevoked: 1,
      correlationId: "startup-upstream-logout",
      retainUntil: Date.now() + 60_000,
      completed: false,
    });
    const auditIntent = {
      id: "startup-audit-intent",
      principalId: pending.principalId,
      organizationId: "org:startup-audit",
      correlationId: "startup-organization-revoke",
      reason: "deprovisioned",
      count: 1,
    };
    await first.ctx.stores.organizationRevocationAudits.set(
      auditIntent.id,
      auditIntent,
    );

    const restarted = createControlPlane(options);
    await restarted.ctx.securityRecoveryReady;
    const resumed = await restarted.ctx.stores.provisionalSessions.get(
      pending.sessionId,
    );
    expect(resumed?.revokedAt).toBeDefined();
    expect(resumed?.revocationCleanupPending).toBeUndefined();
    expect(
      await restarted.ctx.stores.provisionalTokens.get(pending.accessToken),
    ).toBeUndefined();
    expect(
      (await restarted.ctx.stores.upstreamLogoutOperations.get(operationKey))
        ?.completed,
    ).toBe(true);
    expect(
      await restarted.ctx.stores.provisionalTokens.get(upstream.accessToken),
    ).toBeUndefined();
    expect(
      (
        await restarted.app.request("/v1/principals/me", {
          headers: { authorization: `Bearer ${pending.accessToken}` },
        })
      ).status,
    ).toBe(401);
    const events = await restarted.ctx.repos.auditEvents.list({ limit: 100 });
    const pendingAudits = events.filter(
      (event) =>
        event.eventType === "principal.provisional_revoked" &&
        event.sessionId === pending.sessionId,
    );
    const upstreamAudit = events.find(
      (event) => event.eventType === "principal.upstream_logout",
    );
    expect(pendingAudits).toHaveLength(1);
    expect(pendingAudits[0]?.correlationId).toBe("startup-pending-cleanup");
    expect(upstreamAudit?.digest).toBeDefined();
    expect(pendingAudits[0]?.previousDigest).toBe(upstreamAudit?.digest);
    const organizationAudit = events.find(
      (event) => event.id === `organization-revoke:${auditIntent.id}`,
    );
    expect(organizationAudit?.previousDigest).toBe(pendingAudits[0]?.digest);
    expect(organizationAudit).toMatchObject({
      eventType: "organization.member_revoked",
      correlationId: auditIntent.correlationId,
      metadata: { action: "organization.member.revoke", count: 1 },
    });
    expect(
      await restarted.ctx.stores.organizationRevocationAudits.get(
        auditIntent.id,
      ),
    ).toBeUndefined();

    const again = createControlPlane(options);
    await again.ctx.securityRecoveryReady;
    const repeatedEvents = await again.ctx.repos.auditEvents.list({
      limit: 100,
    });
    expect(
      repeatedEvents.filter(
        (event) =>
          event.eventType === "principal.provisional_revoked" &&
          event.sessionId === pending.sessionId,
      ),
    ).toHaveLength(1);
    expect(
      repeatedEvents.filter(
        (event) => event.id === `organization-revoke:${auditIntent.id}`,
      ),
    ).toHaveLength(1);
  } finally {
    await client.close();
  }
});

it("keeps readiness closed when an organization audit intent is invalid", async () => {
  const client = await migratedPGlite();
  try {
    const options = optionsFor(drizzle(client, { schema }));
    const first = createControlPlane(options);
    await first.ctx.securityRecoveryReady;
    await first.ctx.stores.organizationRevocationAudits.set("invalid", {
      id: "",
      principalId: "prn_audit",
      organizationId: "org:audit",
      correlationId: "audit-recovery",
      reason: "deprovisioned",
      count: 1,
    });
    const restarted = createControlPlane(options);
    await expect(restarted.ctx.securityRecoveryReady).rejects.toThrow(
      "Invalid organization revocation audit intent",
    );
    expect((await restarted.app.request("/v1/health/ready")).status).toBe(503);
    expect((await restarted.app.request("/v1/health/live")).status).toBe(200);
    expect(
      await restarted.ctx.stores.organizationRevocationAudits.get("invalid"),
    ).toBeDefined();
  } finally {
    await client.close();
  }
});

it("fails closed when startup cleanup fails and retries on another restart", async () => {
  const client = await migratedPGlite();
  try {
    const db = drizzle(client, { schema });
    const options = optionsFor(db);
    const first = createControlPlane(options);
    await first.ctx.securityRecoveryReady;
    const pending = await mint(first);
    await beginProvisionalRevocation(first.ctx, pending.sessionId, {
      actorType: "system",
      correlationId: "startup-cleanup-failure",
    });

    let reached = () => {};
    let release = () => {};
    const entered = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const failingRepos = new PostgresRepositories(overlapCast(db));
    vi.spyOn(failingRepos.auditEvents, "append").mockImplementationOnce(
      async () => {
        reached();
        await gate;
        throw new Error("audit unavailable during recovery");
      },
    );
    const failing = createControlPlane({ ...options, repos: failingRepos });
    const rejected = expect(failing.ctx.securityRecoveryReady).rejects.toThrow(
      "audit unavailable during recovery",
    );
    await entered;
    const ready = failing.app.request("/v1/health/ready");
    const request = failing.app.request("/v1/principals/me", {
      headers: { authorization: `Bearer ${pending.accessToken}` },
    });
    let served = false;
    void request.then(() => {
      served = true;
    });
    expect((await failing.app.request("/v1/health/live")).status).toBe(200);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(served).toBe(false);
    release();
    await rejected;
    expect((await ready).status).toBe(503);
    expect((await request).status).toBe(503);
    expect(await failing.ctx.securityStateReady()).toBe(false);
    expect(
      (await failing.ctx.stores.provisionalSessions.get(pending.sessionId))
        ?.revocationCleanupPending,
    ).toBe(true);

    const recovered = createControlPlane(options);
    await recovered.ctx.securityRecoveryReady;
    expect(
      (await recovered.ctx.stores.provisionalSessions.get(pending.sessionId))
        ?.revocationCleanupPending,
    ).toBeUndefined();
    expect(
      await recovered.ctx.stores.provisionalTokens.get(pending.accessToken),
    ).toBeUndefined();
    expect((await recovered.app.request("/v1/health/ready")).status).toBe(200);
    const events = await recovered.ctx.repos.auditEvents.list({ limit: 100 });
    expect(
      events.filter(
        (event) =>
          event.eventType === "principal.provisional_revoked" &&
          event.sessionId === pending.sessionId,
      ),
    ).toHaveLength(1);
  } finally {
    await client.close();
  }
});

it("refuses a pending cleanup row without a revocation timestamp", async () => {
  const client = await migratedPGlite();
  try {
    const options = optionsFor(drizzle(client, { schema }));
    const first = createControlPlane(options);
    await first.ctx.securityRecoveryReady;
    const pending = await mint(first);
    const session = await first.ctx.stores.provisionalSessions.get(
      pending.sessionId,
    );
    if (!session) throw new Error("Missing session");
    const proof = "e".repeat(64);
    await first.ctx.stores.provisionalSessions.set(pending.sessionId, {
      ...session,
      restoreProofHash: createHash("sha256").update(proof).digest("hex"),
      revocationCleanupPending: true,
    });

    // A running replica must not authenticate the malformed row either.
    expect(
      (
        await first.app.request("/v1/principals/me", {
          headers: { authorization: `Bearer ${pending.accessToken}` },
        })
      ).status,
    ).toBe(401);
    expect(await boundCookieMatches(first.ctx, pending.sessionId, proof)).toBe(
      false,
    );

    const restarted = createControlPlane(options);
    await expect(restarted.ctx.securityRecoveryReady).rejects.toThrow(
      /pending provisional revocation.*timestamp/i,
    );
    expect((await restarted.app.request("/v1/health/ready")).status).toBe(503);
    expect((await restarted.app.request("/v1/health/live")).status).toBe(200);
    expect(
      (
        await restarted.app.request("/v1/principals/me", {
          headers: { authorization: `Bearer ${pending.accessToken}` },
        })
      ).status,
    ).toBe(503);
  } finally {
    await client.close();
  }
});
