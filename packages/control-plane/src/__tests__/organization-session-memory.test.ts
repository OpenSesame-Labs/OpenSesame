import { MemoryOrganizationMembershipStore } from "@opensesame/database";
import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";
import { withScimOrganizationBoundary } from "../repos/scim-organization-boundary.js";
import { adoptSessionWithinCapacity } from "../routes/federated-session.js";
import {
  ensurePersonalOrganization,
  jitJoinOrganization,
  revokeOrganizationMembership,
  serializeMembershipMutation,
} from "../routes/organizations.js";

describe("memory membership revocation boundary", () => {
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

  it("orders a tenant join and an owner member write without deadlock", async () => {
    const started = createControlPlane({
      processEnv: { ...process.env, DATABASE_URL: "" },
    });
    const response = await started.app.request("/v1/principals/provisional", {
      method: "POST",
    });
    const owner: { principalId: string } = overlapCast(await response.json());
    const { organizationId } = await ensurePersonalOrganization(
      started.ctx,
      owner.principalId,
    );
    const organization = await started.ctx.stores.organizations.get(
      organizationId,
    );
    if (!organization) throw new Error("Expected organization");
    // An owner write takes the in-process mutation turn, then the
    // cross-replica organization boundary. A join must not take them in the
    // opposite order while this write waits.
    let releaseOwner = () => {};
    const ownerGate = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    const ownerWrite = serializeMembershipMutation(
      started.ctx,
      organizationId,
      async () => {
        await ownerGate;
        return withScimOrganizationBoundary(
          started.ctx,
          organizationId,
          async () => "owner-write",
        );
      },
    );
    const join = jitJoinOrganization(started.ctx, {
      organization,
      principalId: "prn_lock_order_joiner",
      subject: "lock-order-joiner",
      method: "oidc",
      correlationId: "lock-order",
    });
    await new Promise((resolve) => setImmediate(resolve));
    releaseOwner();
    const settled = await Promise.race([
      Promise.all([ownerWrite, join]).then(() => "settled"),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("deadlocked"), 2_000),
      ),
    ]);
    expect(settled).toBe("settled");
    expect(await join).toMatchObject({ ok: true, created: true });
  });
});
