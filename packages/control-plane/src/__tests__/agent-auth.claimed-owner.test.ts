import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { json, verifiedWithEmail } from "./agent-auth-kit.js";

describe("AgentAuth claimed tokens and the claiming human's state", () => {
  it("stops minting claimed tokens once the claiming human is suspended", async () => {
    // Gauntlet round 7 (grok): pollClaimGrant loaded only the
    // registration's own (agent) principal, so a human suspended after
    // claiming still had claimed assertions and access tokens minted
    // acting on their behalf.
    const cp = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
    });
    const hono = cp.app;
    const registered = await json(
      await hono.request("/agent/identity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "anonymous" }),
      }),
    );
    const started = await json(
      await hono.request("/agent/identity/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          claim_token: registered.claim_token,
          email: "suspended-owner@example.com",
        }),
      }),
    );
    const userCode = String(overlapCast(started.claim_attempt).user_code);
    const verificationUri = new URL(
      String(overlapCast(started.claim_attempt).verification_uri),
    );
    const returnTo = verificationUri.searchParams.get("return_to") ?? "";
    const claimAttemptToken = new URL(
      returnTo,
      "http://127.0.0.1:8788",
    ).searchParams.get("claim_attempt_token");
    const human = await verifiedWithEmail(hono, "suspended-owner@example.com");
    // Leftover half-promoted owner: a verified identity on a principal
    // that never became durable. sessionMayClaim admits exactly this
    // shape, so completing the claim must finish the promotion before
    // any claimed token can be minted for them.
    const half = await cp.ctx.repos.principals.getById(human.principalId);
    if (!half) throw new Error("expected the claiming principal");
    await cp.ctx.repos.principals.update(
      half.id,
      {
        state: "provisional",
        assurance: "provisional",
        verifiedAt: undefined,
        updatedAt: new Date(),
      },
      half.version,
    );
    const completed = await hono.request("/agent/identity/claim/complete", {
      method: "POST",
      headers: { ...human.auth, "content-type": "application/json" },
      body: JSON.stringify({
        claim_attempt_token: claimAttemptToken,
        user_code: userCode,
      }),
    });
    expect(completed.status).toBe(200);
    expect(
      await cp.ctx.repos.principals.getById(human.principalId),
    ).toMatchObject({ state: "active", assurance: "verified" });

    const owner = await cp.ctx.repos.principals.getById(human.principalId);
    if (!owner) throw new Error("expected the claiming principal");
    await cp.ctx.repos.principals.update(
      owner.id,
      { state: "suspended", updatedAt: new Date() },
      owner.version,
    );

    const polled = await hono.request("/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:workos:agent-auth:grant-type:claim",
        claim_token: String(registered.claim_token),
      }),
    });
    expect(polled.status).not.toBe(200);
    expect((await json(polled)).access_token).toBeUndefined();
  });

  it("refuses an emailless claim by a half-promoted principal with no verified email", async () => {
    // Gauntlet round 8 (grok, kimi): sessionMayClaim treated a human as
    // provisional only when BOTH state and assurance were provisional, so
    // an active/provisional principal with no verified email at all could
    // complete an emailless claim and have claimed tokens minted for a
    // half-promoted owner.
    const cp = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
    });
    const hono = cp.app;
    const registered = await json(
      await hono.request("/agent/identity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "anonymous" }),
      }),
    );
    const started = await json(
      await hono.request("/agent/identity/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ claim_token: registered.claim_token }),
      }),
    );
    const userCode = String(overlapCast(started.claim_attempt).user_code);
    const verificationUri = new URL(
      String(overlapCast(started.claim_attempt).verification_uri),
    );
    const returnTo = verificationUri.searchParams.get("return_to") ?? "";
    const claimAttemptToken = new URL(
      returnTo,
      "http://127.0.0.1:8788",
    ).searchParams.get("claim_attempt_token");

    const guestRes = await hono.request("/v1/principals/provisional", {
      method: "POST",
    });
    expect(guestRes.status).toBe(201);
    const guest = await json(guestRes);
    const principalId = String(guest.principalId);
    const before = await cp.ctx.repos.principals.getById(principalId);
    if (!before) throw new Error("expected the guest principal");
    await cp.ctx.repos.principals.update(
      before.id,
      {
        state: "active",
        assurance: "provisional",
        verifiedAt: undefined,
        updatedAt: new Date(),
      },
      before.version,
    );

    const completed = await hono.request("/agent/identity/claim/complete", {
      method: "POST",
      headers: {
        authorization: `Bearer ${guest.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        claim_attempt_token: claimAttemptToken,
        user_code: userCode,
      }),
    });
    expect(completed.status).toBe(400);
    expect(await cp.ctx.repos.principals.getById(principalId)).toMatchObject({
      state: "active",
      assurance: "provisional",
    });
    const polled = await hono.request("/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:workos:agent-auth:grant-type:claim",
        claim_token: String(registered.claim_token),
      }),
    });
    expect(polled.status).not.toBe(200);
    expect((await json(polled)).access_token).toBeUndefined();
  });
});
