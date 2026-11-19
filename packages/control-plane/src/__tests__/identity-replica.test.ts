import { createPasskeySeam } from "@opensesame/auth-upstream";
import {
  SCIM_DEPROVISION_JOURNAL_ATTRIBUTE,
  createEventSealer,
} from "@opensesame/database";
import * as schema from "@opensesame/database/schema";
import { overlapCast } from "@opensesame/os-domain";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";
import { resumePendingUpstreamLogouts } from "../interactions/upstream-logout.js";
import { DurableMap, incrementSecurityCounter } from "../repos/durable-map.js";
import { durablePasskeyCredentials } from "../repos/durable-passkey-store.js";
import { migratedPGlite, warmMigratedPGlite } from "./migrated-pglite.js";
import { hostRevocationResponse } from "./scim-test-helpers.js";

// Each PGlite test here starts its own database. They used to boot one and
// apply every migration inside the test, which on a loaded CI runner took most
// of the package's 15s budget (legacy-agent-durability timed out on it); now
// the migrations run once per file, in the hook below, and each test loads a
// copy (migrated-pglite.ts). The 60s budget stays as the margin for load.
vi.setConfig({ testTimeout: 60_000 });
beforeAll(warmMigratedPGlite, 60_000);

it("recovers an incomplete upstream logout after restart without an IdP retry", async () => {
  const client = await migratedPGlite();
  try {
    const db = drizzle(client, { schema });
    const options = {
      database: overlapCast(db),
      config: { claimPepper: "replica-test-only-claim-pepper-32chars" },
    };
    const first = createControlPlane(options);
    await first.ctx.securityRecoveryReady;
    const minted = await first.app.request("/v1/principals/provisional", {
      method: "POST",
    });
    const session: {
      sessionId: string;
      principalId: string;
      accessToken: string;
    } = overlapCast(await minted.json());
    const operationKey = `oidc-logout:${"a".repeat(64)}`;
    await first.ctx.stores.upstreamLogoutOperations.set(operationKey, {
      operationKey,
      issuer: "https://issuer.example",
      subject: "subject",
      principalIds: [session.principalId],
      sessionIds: [session.sessionId],
      preparedSessionCount: 1,
      correlationId: "corr-upstream-recovery",
      retainUntil: Date.now() + 60_000,
      completed: false,
    });

    const restarted = createControlPlane(options);
    await restarted.ctx.securityRecoveryReady;
    expect(
      (await restarted.ctx.stores.upstreamLogoutOperations.get(operationKey))
        ?.completed,
    ).toBe(true);
    expect(
      (
        await restarted.app.request("/v1/principals/me", {
          headers: { authorization: `Bearer ${session.accessToken}` },
        })
      ).status,
    ).toBe(401);
    const events = await restarted.ctx.repos.auditEvents.list({ limit: 100 });
    expect(
      events.filter((event) => event.eventType === "principal.upstream_logout"),
    ).toHaveLength(1);

    const completed =
      await restarted.ctx.stores.upstreamLogoutOperations.get(operationKey);
    if (!completed) throw new Error("Missing completed upstream logout");
    await restarted.ctx.stores.upstreamLogoutOperations.set(operationKey, {
      ...completed,
      retainUntil: 0,
    });
    await resumePendingUpstreamLogouts(restarted.ctx);
    expect(
      await restarted.ctx.stores.upstreamLogoutOperations.get(operationKey),
    ).toBeUndefined();
  } finally {
    await client.close();
  }
});

it("recovers a legacy SCIM orphan after restart without a client retry", async () => {
  const client = await migratedPGlite();
  try {
    const db = drizzle(client, { schema });
    const options = {
      database: overlapCast(db),
      config: { claimPepper: "replica-test-only-claim-pepper-32chars" },
    };
    const first = createControlPlane(options);
    await first.ctx.systemPrincipalReady;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const minted = await first.app.request("/v1/principals/provisional", {
      method: "POST",
    });
    const session: { principalId: string; accessToken: string } = overlapCast(
      await minted.json(),
    );
    const membership = (
      await first.ctx.stores.organizationMemberships.listByPrincipal(
        session.principalId,
      )
    )[0];
    if (!membership) throw new Error("Missing personal membership");
    await first.ctx.stores.organizationMemberships.remove(
      membership.organizationId,
      session.principalId,
    );
    const userId = `scim_${randomUUID()}`;
    await first.ctx.stores.scim.users.create({
      id: userId,
      organizationId: membership.organizationId,
      userName: "legacy-orphan@example.test",
      active: false,
      raw: {
        [SCIM_DEPROVISION_JOURNAL_ATTRIBUTE]: {
          cycle: randomUUID(),
          targets: [
            {
              principalId: session.principalId,
              incarnation: randomUUID(),
              completed: false,
              legacyOrphan: {
                authorityRevision: randomUUID(),
                withdrawalId: randomUUID(),
              },
            },
          ],
        },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const host = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init) => hostRevocationResponse(init));

    const restarted = createControlPlane(options);
    await restarted.ctx.systemPrincipalReady;
    await vi.waitFor(async () => {
      const recovered = await restarted.ctx.stores.scim.users.getById(
        membership.organizationId,
        userId,
      );
      const journal = recovered?.raw[SCIM_DEPROVISION_JOURNAL_ATTRIBUTE];
      expect(overlapCast(journal).targets[0]?.completed).toBe(true);
    });
    expect(host).toHaveBeenCalledOnce();
    expect(
      (
        await restarted.app.request("/v1/principals/me", {
          headers: { authorization: `Bearer ${session.accessToken}` },
        })
      ).status,
    ).toBe(200);
  } finally {
    vi.restoreAllMocks();
    await client.close();
  }
});

it("shares sessions/revocation and atomic passkey/counter state across app instances", async () => {
  const client = await migratedPGlite();
  try {
    const db = drizzle(client, { schema });
    const options = {
      database: overlapCast(db),
      config: { claimPepper: "replica-test-only-claim-pepper-32chars" },
    };
    const first = createControlPlane(options);
    const second = createControlPlane(options);
    await Promise.all([
      first.ctx.systemPrincipalReady,
      second.ctx.systemPrincipalReady,
    ]);
    const minted = await first.app.request("/v1/principals/provisional", {
      method: "POST",
    });
    expect(minted.status).toBe(201);
    const body = await minted.json();
    const headers = { authorization: `Bearer ${body.accessToken}` };
    expect(
      (await second.app.request("/v1/principals/me", { headers })).status,
    ).toBe(200);
    expect(
      (
        await second.app.request("/v1/principals/provisional/revoke", {
          method: "POST",
          headers,
        })
      ).status,
    ).toBe(204);
    expect(
      (await first.app.request("/v1/principals/me", { headers })).status,
    ).toBe(401);
    const counters = [1, 2].map(
      () =>
        new DurableMap<number>(
          overlapCast(db),
          "OpenSesame:CounterTest",
          undefined,
          undefined,
          undefined,
          createEventSealer("durable-security-fixture-key"),
        ),
    );
    expect(
      (
        await Promise.all(
          counters.map((store) => incrementSecurityCounter(store, "attempt")),
        )
      ).sort(),
    ).toEqual([1, 2]);
    const makeSeam = () =>
      createPasskeySeam({
        credentialStore: durablePasskeyCredentials(
          overlapCast(db),
          createEventSealer("durable-security-fixture-key"),
        ),
        verifyAssertion: async () => ({ ok: true, newCounter: 2 }),
      });
    const a = makeSeam();
    const b = makeSeam();
    const credential = {
      credentialId: "replica-key",
      publicKey: new Uint8Array([1]),
      counter: 1,
    };
    await a.register(body.principalId, credential);
    await expect(b.register("different-owner", credential)).rejects.toThrow(
      /already registered/,
    );
    const assertion = {
      credentialId: credential.credentialId,
      clientDataJSON: new Uint8Array(),
      authenticatorData: new Uint8Array(),
      signature: new Uint8Array(),
    };
    const results = await Promise.all([
      a.verify(assertion),
      b.verify(assertion),
    ]);
    expect(results.filter(({ ok }) => ok)).toHaveLength(1);
    const replay = {
      id: "oidc-logout:test-digest",
      providerId: "oidc-logout",
      callbackDigest: "test-digest",
      seenAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    };
    expect(await first.ctx.repos.callbackReplays.claim(replay)).toBe(true);
    expect(await second.ctx.repos.callbackReplays.claim(replay)).toBe(false);
    await client.exec("DROP TABLE oidc_payloads");
    expect((await first.app.request("/v1/health/ready")).status).toBe(503);
    expect((await first.app.request("/v1/health/live")).status).toBe(200);
  } finally {
    await client.close();
  }
});

import { randomUUID } from "node:crypto";
