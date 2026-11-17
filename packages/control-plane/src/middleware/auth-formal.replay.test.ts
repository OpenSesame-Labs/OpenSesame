import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { resolveProvisionalSession } from "./auth.js";

function testConfig() {
  return {
    port: 0,
    publicUrl: "http://127.0.0.1:8788",
    issuer: "http://127.0.0.1:8788",
  } as const;
}

describe("control plane session formal replay", () => {
  it("does not resolve a revoked provisional session", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const mint = await app.request("/v1/principals/provisional", {
      method: "POST",
      headers: { "user-agent": "formal-replay" },
    });
    expect(mint.status).toBe(201);
    const body = (await mint.json()) as {
      accessToken: string;
      sessionId: string;
    };
    const session = await ctx.stores.provisionalSessions.get(body.sessionId);
    expect(session).toBeDefined();
    if (session) {
      await ctx.stores.provisionalSessions.set(body.sessionId, {
        ...session,
        revokedAt: ctx.clock(),
      });
    }
    const resolved = await resolveProvisionalSession(ctx, body.accessToken);
    expect(resolved).toBeUndefined();
  });
});