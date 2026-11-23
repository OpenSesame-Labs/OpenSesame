import { createHash } from "node:crypto";
import { overlapCast } from "@opensesame/os-domain";
import { expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";
import { boundCookiePath } from "../middleware/bound-cookie-name.js";

it("dispatches only a cookie bound to the initiating tab's proof and session", async () => {
  const { app } = createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://localhost",
      issuer: "http://localhost",
    },
  });
  const mint = async (proof: string) => {
    const response = await app.request("/v1/principals/provisional", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost",
      },
      body: JSON.stringify({
        restoreProofHash: createHash("sha256").update(proof).digest("hex"),
      }),
    });
    expect(response.status).toBe(201);
    const body: {
      principalId: string;
      sessionId: string;
    } = overlapCast(await response.json());
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("Missing session cookie");
    return { ...body, cookie };
  };
  const proof = "a".repeat(64);
  const first = await mint(proof);
  const second = await mint("b".repeat(64));
  const request = (
    cookie: string,
    sessionId: string,
    secret = proof,
    principalId = first.principalId,
  ) =>
    app.request("/v1/bound/principals/me", {
      headers: {
        cookie,
        "x-opensesame-session-id": sessionId,
        "x-opensesame-session-proof": secret,
        "x-opensesame-principal-id": principalId,
      },
    });
  expect((await request(second.cookie, first.sessionId)).status).toBe(401);
  expect(
    (await request(first.cookie, first.sessionId, "c".repeat(64))).status,
  ).toBe(401);
  const response = await request(first.cookie, first.sessionId);
  expect(response.status).toBe(200);
  expect(response.headers.get("x-opensesame-cookie-bound")).toBe("1");
  const result: {
    id: string;
    accessToken?: string;
  } = overlapCast(await response.json());
  expect(result.id).toBe(first.principalId);
  expect(result.accessToken).toBeUndefined();
  const both = `${first.cookie}; ${second.cookie}`;
  expect((await request(both, first.sessionId)).status).toBe(200);
  expect(
    (await request(both, second.sessionId, "b".repeat(64), second.principalId))
      .status,
  ).toBe(200);
  const blockedMint = await app.request("/v1/bound/session-mint", {
    method: "POST",
    headers: {
      cookie: both,
      origin: "http://localhost",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      restoreProofHash: createHash("sha256")
        .update("d".repeat(64))
        .digest("hex"),
    }),
  });
  expect(blockedMint.status).toBe(409);
  const revoke = await app.request("/v1/bound/principals/provisional/revoke", {
    method: "POST",
    headers: {
      cookie: first.cookie,
      origin: "http://localhost",
      "x-opensesame-session-id": first.sessionId,
      "x-opensesame-session-proof": proof,
      "x-opensesame-principal-id": first.principalId,
    },
  });
  expect(revoke.status).toBe(204);
  expect(revoke.headers.get("set-cookie")).toContain(first.sessionId);
  expect((await request(first.cookie, first.sessionId)).status).toBe(401);
  expect(
    (
      await request(
        second.cookie,
        second.sessionId,
        "b".repeat(64),
        second.principalId,
      )
    ).status,
  ).toBe(200);

  // Explicit sign-out cannot revoke a cookie that changed after it was observed.
  const status = await app.request("/v1/bound/status", {
    headers: { cookie: second.cookie },
  });
  expect(await status.json()).toEqual({ sessions: [second.sessionId] });
  const mismatch = await app.request("/v1/bound/sign-out", {
    method: "POST",
    headers: {
      cookie: second.cookie,
      origin: "http://localhost",
      "content-type": "application/json",
    },
    body: JSON.stringify({ sessionId: first.sessionId }),
  });
  expect(mismatch.status).toBe(409);
  const exited = await app.request("/v1/bound/sign-out", {
    method: "POST",
    headers: {
      cookie: second.cookie,
      origin: "http://localhost",
      "content-type": "application/json",
    },
    body: JSON.stringify({ sessionId: second.sessionId }),
  });
  expect(exited.status).toBe(204);
  expect(exited.headers.get("set-cookie")).toContain(second.sessionId);
  expect(
    (
      await request(
        second.cookie,
        second.sessionId,
        "b".repeat(64),
        second.principalId,
      )
    ).status,
  ).toBe(401);
  const fresh = await app.request("/v1/bound/session-mint", {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify({
      restoreProofHash: createHash("sha256")
        .update("d".repeat(64))
        .digest("hex"),
    }),
  });
  expect(fresh.status).toBe(201);
  expect(fresh.headers.get("x-opensesame-cookie-bound")).toBe("1");
  expect(fresh.headers.get("set-cookie")).toContain("Path=/v1/bound/");
});

it("scopes a slot to the public Identity path behind a reverse proxy", () => {
  expect(boundCookiePath("https://example.test/identity/")).toBe(
    "/identity/v1/bound/",
  );
  expect(boundCookiePath("https://example.test/")).toBe("/v1/bound/");
});

it("revokes the exact proof-bound session after its cookie is no longer present", async () => {
  const { app, ctx } = createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://localhost",
      issuer: "http://localhost",
    },
  });
  const proof = "a".repeat(64);
  const minted = await app.request("/v1/bound/session-mint", {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify({
      restoreProofHash: createHash("sha256").update(proof).digest("hex"),
    }),
  });
  const {
    sessionId,
    principalId,
  }: {
    sessionId: string;
    principalId: string;
  } = overlapCast(await minted.json());
  const cookie = minted.headers.get("set-cookie")?.split(";")[0] ?? "";
  const audit = vi.spyOn(ctx.repos.auditEvents, "append");
  const exit = (secret: string, origin = "http://localhost") =>
    app.request("/v1/bound/proof-sign-out", {
      method: "POST",
      headers: {
        origin,
        "x-opensesame-revoke-session": sessionId,
        "x-opensesame-revoke-secret": secret,
        "x-opensesame-revoke-principal": principalId,
      },
    });
  expect((await exit("b".repeat(64))).status).toBe(401);
  expect((await exit(proof, "https://attacker.example")).status).toBe(403);
  const exits = await Promise.all([exit(proof), exit(proof), exit(proof)]);
  expect(exits.map((response) => response.status)).toEqual([204, 204, 204]);
  expect(
    audit.mock.calls.filter(
      ([event]) => event.eventType === "principal.provisional_revoked",
    ),
  ).toHaveLength(1);
  const writes = vi.spyOn(ctx.stores.provisionalSessions, "set");
  for (let retry = 0; retry < 5; retry += 1)
    expect((await exit(proof)).status).toBe(204);
  expect(writes).not.toHaveBeenCalled();
  const status = await app.request("/v1/bound/status", { headers: { cookie } });
  expect(await status.json()).toEqual({ sessions: [] });
});

it("accepts only the retained proof after the live session row expires", async () => {
  const { app, ctx } = createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://localhost",
      issuer: "http://localhost",
    },
  });
  const proof = "2".repeat(64);
  const minted = await app.request("/v1/bound/session-mint", {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify({
      restoreProofHash: createHash("sha256").update(proof).digest("hex"),
    }),
  });
  const {
    sessionId,
    principalId,
  }: {
    sessionId: string;
    principalId: string;
  } = overlapCast(await minted.json());
  const sessions = ctx.stores.provisionalSessions;
  if (!(sessions instanceof Map)) throw new Error("Expected memory store");
  sessions.delete(sessionId);
  const exit = (secret: string) =>
    app.request("/v1/bound/proof-sign-out", {
      method: "POST",
      headers: {
        origin: "http://localhost",
        "x-opensesame-revoke-session": sessionId,
        "x-opensesame-revoke-secret": secret,
        "x-opensesame-revoke-principal": principalId,
      },
    });
  expect((await exit("3".repeat(64))).status).toBe(401);
  expect((await exit(proof)).status).toBe(204);
});

it("treats a retry as complete after both the session and proof retention expire", async () => {
  const { app, ctx } = createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://localhost",
      issuer: "http://localhost",
    },
  });
  const proof = "4".repeat(64);
  const minted = await app.request("/v1/bound/session-mint", {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify({
      restoreProofHash: createHash("sha256").update(proof).digest("hex"),
    }),
  });
  const {
    sessionId,
    principalId,
  }: {
    sessionId: string;
    principalId: string;
  } = overlapCast(await minted.json());
  const sessions = ctx.stores.provisionalSessions;
  const proofs = ctx.stores.provisionalProofs;
  if (!(sessions instanceof Map) || !(proofs instanceof Map))
    throw new Error("Expected memory stores");
  sessions.delete(sessionId);
  proofs.delete(sessionId);
  const response = await app.request("/v1/bound/proof-sign-out", {
    method: "POST",
    headers: {
      origin: "http://localhost",
      "x-opensesame-revoke-session": sessionId,
      "x-opensesame-revoke-secret": proof,
      "x-opensesame-revoke-principal": principalId,
    },
  });
  expect(response.status).toBe(204);
});
