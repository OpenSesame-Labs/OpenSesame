import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import {
  PrincipalNotActiveError,
  adoptSessionWithinCapacity,
} from "../routes/federated-session.js";

/**
 * Adoption is the one mint every rebind road shares (federated-session
 * exchange, collision rebind, email-join adoption), so the owner-state
 * fence belongs inside it: a caller that read the owner before the mint
 * cannot see a suspension that lands during it, and a half-promoted
 * owner (active state, provisional assurance) must be finished before a
 * session is bound to them — gauntlet round 7 (kimi, cursor).
 */
describe("adoptSessionWithinCapacity owner fence", () => {
  it("refuses to mint a session for a suspended principal", async () => {
    const { ctx } = createControlPlane();
    const now = ctx.clock();
    await ctx.repos.principals.create({
      id: "prn_adopt_suspended",
      state: "suspended",
      assurance: "verified",
      createdAt: now,
      updatedAt: now,
      version: 1,
    });

    await expect(
      adoptSessionWithinCapacity(ctx, "prn_adopt_suspended", "corr-1"),
    ).rejects.toBeInstanceOf(PrincipalNotActiveError);
    expect(await ctx.stores.provisionalSessions.size).toBe(0);
  });

  it("promotes a half-promoted owner before binding the session", async () => {
    const { ctx } = createControlPlane();
    const now = ctx.clock();
    await ctx.repos.principals.create({
      id: "prn_adopt_half",
      state: "active",
      assurance: "provisional",
      createdAt: now,
      updatedAt: now,
      version: 1,
    });

    const adopted = await adoptSessionWithinCapacity(
      ctx,
      "prn_adopt_half",
      "corr-2",
    );

    expect(adopted.principalId).toBe("prn_adopt_half");
    expect(await ctx.repos.principals.getById("prn_adopt_half")).toMatchObject({
      state: "active",
      assurance: "verified",
    });
  });
});
