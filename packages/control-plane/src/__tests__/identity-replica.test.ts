import { createHash } from "node:crypto";
import { appendAuditEvent, verifyAuditChain } from "@opensesame/audit";
import * as schema from "@opensesame/database/schema";
import { overlapCast } from "@opensesame/os-domain";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";
import { resumePendingUpstreamLogouts } from "../interactions/upstream-logout.js";
import { DurableMap } from "../repos/durable-map.js";
import { beginProvisionalRevocation } from "../repos/provisional-revocation.js";
import { saveProvisional } from "../repos/session-storage.js";
import { migratedPGlite, warmMigratedPGlite } from "./migrated-pglite.js";

// Each PGlite test here starts its own database. They used to boot one and
// apply every migration inside the test, which on a loaded CI runner took most
// of the package's 15s budget (legacy-agent-durability timed out on it); now
// the migrations run once per file, in the hook below, and each test loads a
// copy (migrated-pglite.ts). The 60s budget stays as the margin for load.
vi.setConfig({ testTimeout: 60_000 });
beforeAll(warmMigratedPGlite, 60_000);

it("records proof sign-out once when two database-backed replicas race", async () => {
  const client = await migratedPGlite();
  try {
    const db = drizzle(client, { schema });
    const options = {
      database: overlapCast(db),
      config: {
        port: 0,
        publicUrl: "http://localhost",
        issuer: "http://localhost",
        claimPepper: "replica-test-only-claim-pepper-32chars",
      },
    };
    const first = createControlPlane(options);
    const second = createControlPlane(options);
    await Promise.all([
      first.ctx.systemPrincipalReady,
      second.ctx.systemPrincipalReady,
    ]);
    const proof = "e".repeat(64);
    const minted = await first.app.request("/v1/bound/session-mint", {
      method: "POST",
      headers: {
        origin: "http://localhost",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        restoreProofHash: createHash("sha256").update(proof).digest("hex"),
      }),
    });
    expect(minted.status).toBe(201);
    const {
      sessionId,
      principalId,
    }: {
      sessionId: string;
      principalId: string;
    } = overlapCast(await minted.json());
    let arrived = 0;
    let release = () => {};
    const together = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (const ctx of [first.ctx, second.ctx]) {
      const read = ctx.repos.auditEvents.getById.bind(ctx.repos.auditEvents);
      vi.spyOn(ctx.repos.auditEvents, "getById").mockImplementation(
        async (id) => {
          const event = await read(id);
          arrived += 1;
          if (arrived === 2) release();
          await together;
          return event;
        },
      );
    }
    const exit = (app: typeof first.app) =>
      app.request("/v1/bound/proof-sign-out", {
        method: "POST",
        headers: {
          origin: "http://localhost",
          "x-opensesame-revoke-session": sessionId,
          "x-opensesame-revoke-secret": proof,
          "x-opensesame-revoke-principal": principalId,
        },
      });
    const responses = await Promise.all([exit(first.app), exit(second.app)]);
    expect(responses.map((response) => response.status)).toEqual([204, 204]);
    await appendAuditEvent(second.ctx.repos.auditEvents, {
      eventType: "test.after_revoke",
      outcome: "succeeded",
    });
    const events = await first.ctx.repos.auditEvents.list({ limit: 100 });
    expect(
      events.filter(
        (event) =>
          event.eventType === "principal.provisional_revoked" &&
          event.sessionId === sessionId,
      ),
    ).toHaveLength(1);
    expect(verifyAuditChain([...events].reverse()).ok).toBe(true);
    const raw = await db.select().from(schema.auditEvents);
    expect(
      raw.find((event) => event.eventType === "principal.provisional_revoked")
        ?.metadata,
    ).toHaveProperty("$sealed");
  } finally {
    await client.close();
  }
});

it("resumes a durable pending revocation by the session's unhashed id on another replica", async () => {
  const client = await migratedPGlite();
  try {
    const db = drizzle(client, { schema });
    const options = {
      database: overlapCast(db),
      config: {
        port: 0,
        publicUrl: "http://localhost",
        issuer: "http://localhost",
        claimPepper: "replica-test-only-claim-pepper-32chars",
      },
    };
    const first = createControlPlane(options);
    await first.ctx.systemPrincipalReady;
    const minted = await first.app.request("/v1/principals/provisional", {
      method: "POST",
    });
    const body: {
      sessionId: string;
      accessToken: string;
    } = overlapCast(await minted.json());
    await beginProvisionalRevocation(first.ctx, body.sessionId, {
      actorType: "system",
      correlationId: "durable-resume-test",
    });
    expect(
      (await first.ctx.stores.provisionalSessions.get(body.sessionId))
        ?.revocationCleanupPending,
    ).toBe(true);

    const second = createControlPlane(options);
    await second.ctx.systemPrincipalReady;
    expect(
      (
        await second.app.request("/v1/principals/provisional", {
          method: "POST",
        })
      ).status,
    ).toBe(201);
    const resumed = await second.ctx.stores.provisionalSessions.get(
      body.sessionId,
    );
    expect(resumed?.revokedAt).toBeDefined();
    expect(resumed?.revocationCleanupPending).toBeUndefined();
    expect(
      (
        await second.app.request("/v1/principals/me", {
          headers: { authorization: `Bearer ${body.accessToken}` },
        })
      ).status,
    ).toBe(401);
    expect(
      await second.ctx.stores.provisionalTokens.get(body.accessToken),
    ).toBeUndefined();
    const events = await second.ctx.repos.auditEvents.list({ limit: 100 });
    expect(
      events.filter(
        (event) =>
          event.eventType === "principal.provisional_revoked" &&
          event.sessionId === body.sessionId,
      ),
    ).toHaveLength(1);
  } finally {
    await client.close();
  }
});

it("resumes a durable upstream logout by its logical key and records the aggregate audit", async () => {
  const client = await migratedPGlite();
  try {
    const db = drizzle(client, { schema });
    const options = {
      database: overlapCast(db),
      config: {
        port: 0,
        publicUrl: "http://localhost",
        issuer: "http://localhost",
        claimPepper: "replica-test-only-claim-pepper-32chars",
      },
    };
    const first = createControlPlane(options);
    await first.ctx.securityRecoveryReady;
    const minted = await first.app.request("/v1/principals/provisional", {
      method: "POST",
    });
    const body: {
      sessionId: string;
      accessToken: string;
    } = overlapCast(await minted.json());
    const operationKey = `oidc-logout:${"a".repeat(64)}`;
    await first.ctx.stores.upstreamLogoutOperations.set(operationKey, {
      operationKey,
      issuer: "https://issuer.example",
      subject: "subject",
      sessionIds: [body.sessionId],
      sessionsRevoked: 1,
      correlationId: "corr-upstream-recovery",
      retainUntil: Date.now() + 60_000,
      completed: false,
    });

    const second = createControlPlane(options);
    await second.ctx.securityRecoveryReady;
    expect(
      (await second.ctx.stores.upstreamLogoutOperations.get(operationKey))
        ?.completed,
    ).toBe(true);
    expect(
      (
        await second.app.request("/v1/principals/me", {
          headers: { authorization: `Bearer ${body.accessToken}` },
        })
      ).status,
    ).toBe(401);
    expect(
      await second.ctx.stores.provisionalTokens.get(body.accessToken),
    ).toBeUndefined();
    const events = await second.ctx.repos.auditEvents.list({ limit: 100 });
    expect(
      events.filter((event) => event.eventType === "principal.upstream_logout"),
    ).toHaveLength(1);
    expect(verifyAuditChain([...events].reverse()).ok).toBe(true);
    const completed =
      await second.ctx.stores.upstreamLogoutOperations.get(operationKey);
    if (!completed) throw new Error("Missing completed upstream logout");
    await second.ctx.stores.upstreamLogoutOperations.set(operationKey, {
      ...completed,
      retainUntil: 0,
    });
    await resumePendingUpstreamLogouts(second.ctx);
    expect(
      await second.ctx.stores.upstreamLogoutOperations.get(operationKey),
    ).toBeUndefined();
  } finally {
    await client.close();
  }
});

it("rolls back durable session publication when writing the bearer fails", async () => {
  const client = await migratedPGlite();
  try {
    const db = drizzle(client, { schema });
    const control = createControlPlane({
      database: overlapCast(db),
      config: {
        port: 0,
        publicUrl: "http://localhost",
        issuer: "http://localhost",
        claimPepper: "replica-test-only-claim-pepper-32chars",
      },
    });
    await control.ctx.securityRecoveryReady;
    const minted = await control.app.request("/v1/principals/provisional", {
      method: "POST",
    });
    const body: {
      sessionId: string;
      principalId: string;
    } = overlapCast(await minted.json());
    const original = await control.ctx.stores.provisionalSessions.get(
      body.sessionId,
    );
    if (!original) throw new Error("Missing source session");
    const tokenStore = control.ctx.stores.provisionalTokens;
    if (!(tokenStore instanceof DurableMap))
      throw new Error("Expected durable token store");
    const bind = tokenStore.onDatabase.bind(tokenStore);
    vi.spyOn(tokenStore, "onDatabase").mockImplementationOnce((database) => {
      const bound = bind(database);
      vi.spyOn(bound, "set").mockRejectedValueOnce(
        new Error("token write failed"),
      );
      return bound;
    });
    const session = { ...original, id: `${body.sessionId}-crossing` };
    const token = "pst_durable_crossing_token";

    await expect(
      saveProvisional(control.ctx.stores, session, token),
    ).rejects.toThrow("token write failed");
    expect(
      await control.ctx.stores.provisionalSessions.get(session.id),
    ).toBeUndefined();
    expect(
      await control.ctx.stores.provisionalTokens.get(token),
    ).toBeUndefined();
    expect(
      (
        await control.app.request("/v1/principals/me", {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(401);
  } finally {
    await client.close();
  }
});
