import { createHash } from "node:crypto";
import { verifyAuditChain } from "@opensesame/audit";
import { MemoryRepositories } from "@opensesame/database";
import { expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";

it("records one proof revocation across independent server instances", async () => {
  const repos = new MemoryRepositories();
  const config = {
    port: 0,
    publicUrl: "http://localhost",
    issuer: "http://localhost",
  };
  const first = createControlPlane({ config, repos });
  const second = createControlPlane({ config, repos });
  second.ctx.stores.provisionalSessions = first.ctx.stores.provisionalSessions;
  second.ctx.stores.provisionalTokens = first.ctx.stores.provisionalTokens;
  const proof = "f".repeat(64);
  const minted = await first.app.request("/v1/bound/session-mint", {
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
  let arrived = 0;
  let release = () => {};
  const together = new Promise<void>((resolve) => {
    release = resolve;
  });
  for (const ctx of [first.ctx, second.ctx]) {
    const read = ctx.repos.auditEvents.getById.bind(ctx.repos.auditEvents);
    vi.spyOn(ctx.repos.auditEvents, "getById").mockImplementation(
      async (id) => {
        const result = await read(id);
        arrived += 1;
        if (arrived === 2) release();
        await together;
        return result;
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
  const events = await repos.auditEvents.list({ limit: 100 });
  expect(
    events.filter(
      (event) =>
        event.eventType === "principal.provisional_revoked" &&
        event.sessionId === sessionId,
    ),
  ).toHaveLength(1);
  expect(verifyAuditChain([...events].reverse()).ok).toBe(true);
});

it("issues a secure cross-site cookie for an HTTPS Identity deployment", async () => {
  const { app } = createControlPlane({
    config: {
      port: 0,
      publicUrl: "https://localhost/identity",
      issuer: "https://localhost/identity",
    },
  });
  const response = await app.request("/v1/bound/session-mint", {
    method: "POST",
    headers: {
      origin: "https://localhost",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      restoreProofHash: createHash("sha256")
        .update("a".repeat(64))
        .digest("hex"),
    }),
  });
  expect(response.status).toBe(201);
  const cookie = response.headers.get("set-cookie") ?? "";
  expect(cookie).toMatch(/SameSite=None/i);
  expect(cookie).toMatch(/;\s*Secure/i);
  expect(cookie).toContain("Path=/identity/v1/bound/");
});

it("refuses proof-bearing public mints from an untrusted simple cross-site request", async () => {
  const { app } = createControlPlane({
    config: {
      port: 0,
      publicUrl: "https://localhost",
      issuer: "https://localhost",
    },
  });
  const response = await app.request("/v1/principals/provisional", {
    method: "POST",
    headers: {
      origin: "https://attacker.example",
      "content-type": "text/plain",
    },
    body: JSON.stringify({ restoreProofHash: "a".repeat(64) }),
  });
  expect(response.status).toBe(403);
  expect(response.headers.get("set-cookie")).toBeNull();
});

it("cleans oversized sets of invalid session slots without blocking status", async () => {
  const { app } = createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://localhost",
      issuer: "http://localhost",
    },
  });
  const prefix = "os_provisional_bound_";
  const cookie = Array.from(
    { length: 65 },
    (_, i) => `${prefix}ps_test${i}=invalid`,
  ).join("; ");
  const response = await app.request("/v1/bound/status", {
    headers: { cookie },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ sessions: [], more: true });
  expect(response.headers.get("set-cookie")).toContain(`${prefix}ps_test0`);
});
