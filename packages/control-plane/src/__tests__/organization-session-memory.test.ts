import { MemoryOrganizationMembershipStore } from "@opensesame/database";
import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";
import { withPrincipalSessionBoundary } from "../repos/principal-session-boundary.js";
import { adoptSessionWithinCapacity } from "../routes/federated-session.js";
import {
  ensurePersonalOrganization,
  revokeOrganizationMembership,
  serializeMembershipMutation,
} from "../routes/organizations.js";

describe("memory membership revocation boundary", () => {
  it("takes the organization turn before the principal boundary", async () => {
    const started = createControlPlane({
      processEnv: { ...process.env, DATABASE_URL: "" },
    });
    const principalId = "prn_lock_order";
    const organizationId = "org:lock-order";
    let releaseOrganization = () => {};
    let organizationHeld = () => {};
    const held = new Promise<void>((resolve) => {
      organizationHeld = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseOrganization = resolve;
    });
    const ownerMutation = serializeMembershipMutation(
      started.ctx,
      organizationId,
      async () => {
        organizationHeld();
        await release;
      },
    );
    await held;

    const revoking = revokeOrganizationMembership(started.ctx, {
      organizationId,
      principalId,
      correlationId: "lock-order",
      reason: "deprovisioned",
    });
    await Promise.resolve();
    await withPrincipalSessionBoundary(
      started.ctx.stores,
      principalId,
      "revoke",
      async () => undefined,
    );

    releaseOrganization();
    await ownerMutation;
    await revoking;
  });

  it("refuses session publication while revocation is pending", async () => {
    const started = createControlPlane({
      processEnv: { ...process.env, DATABASE_URL: "" },
    });
    const response = await started.app.request("/v1/principals/provisional", {
      method: "POST",
    });
    const person: { principalId: string } = overlapCast(await response.json());
    const membership = await ensurePersonalOrganization(
      started.ctx,
      person.principalId,
    );
    let reached = () => {};
    let release = () => {};
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = MemoryOrganizationMembershipStore.prototype.remove;
    vi.spyOn(
      MemoryOrganizationMembershipStore.prototype,
      "remove",
    ).mockImplementationOnce(async function (...args) {
      const removed = original.apply(this, args);
      reached();
      await gate;
      return removed;
    });
    const revoking = revokeOrganizationMembership(started.ctx, {
      organizationId: membership.organizationId,
      principalId: person.principalId,
      correlationId: "memory-overlap",
      reason: "deprovisioned",
    });
    await paused;
    try {
      await expect(
        adoptSessionWithinCapacity(
          started.ctx,
          person.principalId,
          "during-removal",
        ),
      ).rejects.toThrow(/session authority changed/i);
    } finally {
      release();
    }
    await revoking;
  });
});
