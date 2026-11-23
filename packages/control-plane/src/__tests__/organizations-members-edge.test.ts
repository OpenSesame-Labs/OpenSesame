import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";

import {
  auth,
  createOrg,
  mockHostFetch,
  provisional,
  testConfig,
  verified,
} from "./organizations-edge.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("organizations routes edge cases", () => {
  it("changes roles only through the owner and rolls back when Host fails", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await verified(app, "org-role-owner");
    const member = await provisional(app);

    const org = overlapCast(
      await (await createOrg(app, owner.accessToken, "role-org")).json(),
    );
    await app.request(`/v1/organizations/${org.id}/members`, {
      method: "POST",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ principalId: member.principalId, role: "member" }),
    });

    const change = (
      token: string,
      target: string,
      body: BoundaryValue,
      orgId = org.id,
    ) =>
      app.request(`/v1/organizations/${orgId}/members/${target}`, {
        method: "PATCH",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    expect(
      (
        await change(
          owner.accessToken,
          member.principalId,
          { role: "admin" },
          "org:missing",
        )
      ).status,
    ).toBe(404);
    expect(
      (await change(member.accessToken, member.principalId, { role: "admin" }))
        .status,
    ).toBe(403);
    expect(
      (await change(owner.accessToken, "prn_missing", { role: "admin" }))
        .status,
    ).toBe(404);
    expect(
      (await change(owner.accessToken, member.principalId, {})).status,
    ).toBe(400);

    // No-op change answers with the current membership without calling Host.
    const fetchSpy = mockHostFetch(() =>
      Promise.resolve(new Response("{}", { status: 200 })),
    );
    const noop = await change(owner.accessToken, member.principalId, {
      role: "member",
    });
    expect(noop.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();

    // The last owner cannot be demoted.
    const lastOwner = await change(owner.accessToken, owner.principalId, {
      role: "member",
    });
    expect(lastOwner.status).toBe(409);
    expect(overlapCast(await lastOwner.json()).error).toBe("last_owner");

    // Host acknowledgement gates the change.
    const promoted = await change(owner.accessToken, member.principalId, {
      role: "admin",
    });
    expect(promoted.status).toBe(200);
    expect(overlapCast(await promoted.json()).role).toBe("admin");

    // Host failure restores the previous role.
    fetchSpy.mockResolvedValue(new Response("nope", { status: 500 }));
    const failed = await change(owner.accessToken, member.principalId, {
      role: "member",
    });
    expect(failed.status).toBe(502);
    expect(overlapCast(await failed.json()).error).toBe(
      "session_revocation_failed",
    );
    const members = await app.request(`/v1/organizations/${org.id}/members`, {
      headers: auth(owner.accessToken),
    });
    const rows = overlapCast(await members.json()).members;
    expect(rows.find((m) => m.principalId === member.principalId)?.role).toBe(
      "admin",
    );

    // An unreachable Host rolls back the same way.
    fetchSpy.mockRejectedValue(new Error("connection refused"));
    const unreachable = await change(owner.accessToken, member.principalId, {
      role: "member",
    });
    expect(unreachable.status).toBe(502);
  });

  it("removes members with owner and last-owner fences and Host rollback", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await verified(app, "org-remove-owner");
    const member = await provisional(app);
    const outsider = await provisional(app);

    const org = overlapCast(
      await (await createOrg(app, owner.accessToken, "remove-org")).json(),
    );
    await app.request(`/v1/organizations/${org.id}/members`, {
      method: "POST",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ principalId: member.principalId, role: "member" }),
    });

    const remove = (token: string, target: string, orgId = org.id) =>
      app.request(`/v1/organizations/${orgId}/members/${target}`, {
        method: "DELETE",
        headers: auth(token),
      });

    expect(
      (await remove(owner.accessToken, member.principalId, "org:missing"))
        .status,
    ).toBe(404);
    expect(
      (await remove(outsider.accessToken, member.principalId)).status,
    ).toBe(404);
    expect((await remove(member.accessToken, owner.principalId)).status).toBe(
      403,
    );
    expect((await remove(owner.accessToken, "prn_missing")).status).toBe(404);

    const lastOwner = await remove(owner.accessToken, owner.principalId);
    expect(lastOwner.status).toBe(409);
    expect(overlapCast(await lastOwner.json()).error).toBe("last_owner");

    // Host failure keeps the membership in place.
    const fetchSpy = mockHostFetch(() =>
      Promise.resolve(new Response("nope", { status: 500 })),
    );
    const failed = await remove(owner.accessToken, member.principalId);
    expect(failed.status).toBe(502);
    expect(
      (
        await app.request(`/v1/organizations/${org.id}/members`, {
          headers: auth(owner.accessToken),
        })
      ).status,
    ).toBe(200);

    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
    expect((await remove(owner.accessToken, member.principalId)).status).toBe(
      204,
    );
    const after = await app.request(`/v1/organizations/${org.id}/members`, {
      headers: auth(owner.accessToken),
    });
    expect(overlapCast(await after.json()).members).toHaveLength(1);
  });
});
