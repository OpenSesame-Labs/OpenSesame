import { createHash } from "node:crypto";
import { auditEventDigest, verifyAuditChain } from "@opensesame/audit";
import { MemoryRepositories } from "@opensesame/database";
import { expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";

it("retries proof-based cleanup after an audit write fails", async () => {
  const { app, ctx } = createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://localhost",
      issuer: "http://localhost",
    },
  });
  const proof = "c".repeat(64);
  const minted = await app.request("/v1/bound/session-mint", {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify({
      restoreProofHash: createHash("sha256").update(proof).digest("hex"),
    }),
  });
  const { sessionId, principalId } = (await minted.json()) as {
    sessionId: string;
    principalId: string;
  };
  const audit = vi
    .spyOn(ctx.repos.auditEvents, "append")
    .mockRejectedValueOnce(new Error("audit unavailable"));
  const exit = () =>
    app.request("/v1/bound/proof-sign-out", {
      method: "POST",
      headers: {
        origin: "http://localhost",
        "x-opensesame-revoke-session": sessionId,
        "x-opensesame-revoke-secret": proof,
        "x-opensesame-revoke-principal": principalId,
      },
    });
  expect((await exit()).status).toBe(500);
  expect(
    (await ctx.stores.provisionalSessions.get(sessionId))
      ?.revocationCleanupPending,
  ).toBe(true);
  expect((await exit()).status).toBe(204);
  expect(
    (await ctx.stores.provisionalSessions.get(sessionId))
      ?.revocationCleanupPending,
  ).toBeUndefined();
  expect((await exit()).status).toBe(204);
  expect(audit).toHaveBeenCalledTimes(2);
});

it("resumes pending proof cleanup during a later mint after the original tab is gone", async () => {
  const { app, ctx } = createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://localhost",
      issuer: "http://localhost",
    },
  });
  const proof = "7".repeat(64);
  const minted = await app.request("/v1/bound/session-mint", {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify({
      restoreProofHash: createHash("sha256").update(proof).digest("hex"),
    }),
  });
  const { sessionId, principalId } = (await minted.json()) as {
    sessionId: string;
    principalId: string;
  };
  vi.spyOn(ctx.repos.auditEvents, "append").mockRejectedValueOnce(
    new Error("audit unavailable"),
  );
  const failed = await app.request("/v1/bound/proof-sign-out", {
    method: "POST",
    headers: {
      origin: "http://localhost",
      "x-opensesame-revoke-session": sessionId,
      "x-opensesame-revoke-secret": proof,
      "x-opensesame-revoke-principal": principalId,
    },
  });
  expect(failed.status).toBe(500);
  expect(
    (await ctx.stores.provisionalSessions.get(sessionId))
      ?.revocationCleanupPending,
  ).toBe(true);
  const next = await app.request("/v1/bound/session-mint", {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify({
      restoreProofHash: createHash("sha256")
        .update("8".repeat(64))
        .digest("hex"),
    }),
  });
  expect(next.status).toBe(201);
  expect(
    (await ctx.stores.provisionalSessions.get(sessionId))
      ?.revocationCleanupPending,
  ).toBeUndefined();
  expect(
    (await ctx.repos.auditEvents.list({ limit: 100 })).filter(
      (event) =>
        event.eventType === "principal.provisional_revoked" &&
        event.sessionId === sessionId,
    ),
  ).toHaveLength(1);
});

it("does not treat a bare revoked marker as completed proof cleanup", async () => {
  const { app, ctx } = createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://localhost",
      issuer: "http://localhost",
    },
  });
  const proof = "9".repeat(64);
  const minted = await app.request("/v1/bound/session-mint", {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify({
      restoreProofHash: createHash("sha256").update(proof).digest("hex"),
    }),
  });
  const { sessionId, principalId } = (await minted.json()) as {
    sessionId: string;
    principalId: string;
  };
  const session = await ctx.stores.provisionalSessions.get(sessionId);
  if (!session) throw new Error("Missing session");
  await ctx.stores.provisionalSessions.set(sessionId, {
    ...session,
    revokedAt: new Date(),
  });
  const exited = await app.request("/v1/bound/proof-sign-out", {
    method: "POST",
    headers: {
      origin: "http://localhost",
      "x-opensesame-revoke-session": sessionId,
      "x-opensesame-revoke-secret": proof,
      "x-opensesame-revoke-principal": principalId,
    },
  });
  expect(exited.status).toBe(204);
  expect(
    (await ctx.repos.auditEvents.list({ limit: 100 })).filter(
      (event) =>
        event.eventType === "principal.provisional_revoked" &&
        event.sessionId === sessionId,
    ),
  ).toHaveLength(1);
  let tokenRemains = false;
  for (const [, id] of await ctx.stores.provisionalTokens.entries()) {
    if (id === sessionId) tokenRemains = true;
  }
  expect(tokenRemains).toBe(false);
});

it("does not duplicate the audit event when cleanup fails after the audit commits", async () => {
  const { app, ctx } = createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://localhost",
      issuer: "http://localhost",
    },
  });
  const proof = "e".repeat(64);
  const minted = await app.request("/v1/bound/session-mint", {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify({
      restoreProofHash: createHash("sha256").update(proof).digest("hex"),
    }),
  });
  expect(minted.status).toBe(201);
  const { sessionId, principalId } = (await minted.json()) as {
    sessionId: string;
    principalId: string;
  };
  const store = ctx.stores.provisionalSessions;
  if (!(store instanceof Map)) throw new Error("Expected memory session store");
  const set = store.set.bind(store);
  let interrupted = false;
  vi.spyOn(store, "set").mockImplementation((id, session) => {
    if (
      id === sessionId &&
      session.revokedAt &&
      !session.revocationCleanupPending &&
      !interrupted
    ) {
      interrupted = true;
      throw new Error("cleanup interrupted");
    }
    return set(id, session);
  });
  const exit = () =>
    app.request("/v1/bound/proof-sign-out", {
      method: "POST",
      headers: {
        origin: "http://localhost",
        "x-opensesame-revoke-session": sessionId,
        "x-opensesame-revoke-secret": proof,
        "x-opensesame-revoke-principal": principalId,
      },
    });
  expect((await exit()).status).toBe(500);
  expect(store.get(sessionId)?.revocationCleanupPending).toBe(true);
  expect((await exit()).status).toBe(204);
  const events = await ctx.repos.auditEvents.list({ limit: 100 });
  expect(
    events.filter(
      (event) =>
        event.eventType === "principal.provisional_revoked" &&
        event.sessionId === sessionId,
    ),
  ).toHaveLength(1);
  expect(verifyAuditChain([...events].reverse()).ok).toBe(true);
});

it("does not accept a detached audit row as completed revocation", async () => {
  const repos = new MemoryRepositories();
  const { app, ctx } = createControlPlane({
    repos,
    config: {
      port: 0,
      publicUrl: "http://localhost",
      issuer: "http://localhost",
    },
  });
  const proof = "6".repeat(64);
  const minted = await app.request("/v1/bound/session-mint", {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify({
      restoreProofHash: createHash("sha256").update(proof).digest("hex"),
    }),
  });
  const { sessionId, principalId } = (await minted.json()) as {
    sessionId: string;
    principalId: string;
  };
  vi.spyOn(ctx.repos.auditEvents, "append").mockRejectedValueOnce(
    new Error("audit unavailable"),
  );
  const exit = () =>
    app.request("/v1/bound/proof-sign-out", {
      method: "POST",
      headers: {
        origin: "http://localhost",
        "x-opensesame-revoke-session": sessionId,
        "x-opensesame-revoke-secret": proof,
        "x-opensesame-revoke-principal": principalId,
      },
    });
  expect((await exit()).status).toBe(500);
  const session = await ctx.stores.provisionalSessions.get(sessionId);
  if (!session?.revocationCleanup) throw new Error("Missing cleanup journal");
  const detachedRoot = "detached-root";
  const predecessor = {
    id: "detached-predecessor",
    occurredAt: new Date(),
    eventType: "test.detached",
    outcome: "succeeded" as const,
    correlationId: "detached",
    metadata: {},
    previousDigest: detachedRoot,
  };
  const predecessorDigest = auditEventDigest(predecessor, detachedRoot);
  await repos.auditEvents.append({
    ...predecessor,
    digest: predecessorDigest,
  });
  const previousDigest = predecessorDigest;
  const event = {
    id: `provisional-revoke:${createHash("sha256")
      .update(sessionId)
      .digest("hex")}`,
    occurredAt: new Date(),
    eventType: "principal.provisional_revoked",
    outcome: "succeeded" as const,
    principalId,
    sessionId,
    correlationId: session.revocationCleanup.correlationId,
    actorType: session.revocationCleanup.actorType,
    metadata: {
      ...session.revocationCleanup.metadata,
      action: "principal.provisional_revoke",
    },
    previousDigest,
  };
  await repos.auditEvents.append({
    ...event,
    digest: auditEventDigest(event, previousDigest),
  });

  expect((await exit()).status).toBe(500);
  expect(
    (await ctx.stores.provisionalSessions.get(sessionId))
      ?.revocationCleanupPending,
  ).toBe(true);
});
