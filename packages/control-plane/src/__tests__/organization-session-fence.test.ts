import { overlapCast } from "@opensesame/os-domain";
import { expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";
import { adoptSessionWithinCapacity } from "../routes/federated-session.js";
import {
  ensurePersonalOrganization,
  revokeOrganizationMembership,
} from "../routes/organizations.js";

it("keeps session publication fenced while two replicas deprovision the same member", async () => {
  const { app, ctx } = createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://localhost",
      issuer: "http://localhost",
    },
  });
  const minted = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  const { principalId }: { principalId: string } = overlapCast(
    await minted.json(),
  );
  const membership = await ensurePersonalOrganization(ctx, principalId);
  // Replicas share durable stores, but each has its own in-process mutex.
  const other = {
    ...ctx,
    stores: { ...ctx.stores, organizationMembershipMutations: new Map() },
  };
  const sessions = ctx.stores.provisionalSessions;
  if (!(sessions instanceof Map)) throw new Error("Expected memory store");
  const values = sessions.values.bind(sessions);
  let reached = () => {};
  let release = () => {};
  const paused = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(sessions, "values").mockImplementationOnce(
    overlapCast(async () => {
      const snapshot = [...values()];
      reached();
      await gate;
      return snapshot;
    }),
  );
  const input = {
    organizationId: membership.organizationId,
    principalId,
    correlationId: "concurrent-deprovision",
    reason: "deprovisioned" as const,
  };
  const first = revokeOrganizationMembership(ctx, input);
  await paused;
  const second = revokeOrganizationMembership(other, input);
  try {
    const blocked = await adoptSessionWithinCapacity(
      other,
      principalId,
      "overlapping-adoption",
    ).then(
      () => false,
      (error) => {
        expect(error).toBeInstanceOf(Error);
        expect(String(error)).toMatch(/epoch/i);
        return true;
      },
    );
    expect(blocked).toBe(true);
  } finally {
    release();
    const [one, two] = await Promise.all([first, second]);
    expect(one.membershipRemoved).toBe(true);
    expect(two.membershipRemoved).toBe(false);
    vi.restoreAllMocks();
  }
});
