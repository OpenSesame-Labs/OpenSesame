import { overlapCast } from "@opensesame/os-domain";
import { expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";

it("rechecks owner authority before a delayed SCIM group mapping is applied", async () => {
  const plane = createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://localhost",
      issuer: "http://localhost",
    },
  });
  const { app, ctx } = plane;
  await ctx.securityRecoveryReady;
  const issued = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(issued.status).toBe(201);
  const person: { principalId: string; accessToken: string } = overlapCast(
    await issued.json(),
  );
  const now = ctx.clock();
  const organizationId = "org-scim-mapping-owner-race";
  await ctx.stores.organizations.set(organizationId, {
    id: organizationId,
    slug: "scim-mapping-owner-race",
    displayName: "Mapping race",
    state: "active",
    createdBy: person.principalId,
    createdAt: now,
    updatedAt: now,
  });
  const membership = {
    organizationId,
    principalId: person.principalId,
    role: "owner" as const,
    createdAt: now,
    updatedAt: now,
  };
  await ctx.stores.organizationMemberships.upsert(membership);
  let proofRead = () => {};
  const proofObserved = new Promise<void>((resolve) => {
    proofRead = resolve;
  });
  const find = ctx.stores.organizationMemberships.findVersioned.bind(
    ctx.stores.organizationMemberships,
  );
  vi.spyOn(
    ctx.stores.organizationMemberships,
    "findVersioned",
  ).mockImplementationOnce(async (...args) => {
    const observed = await find(...args);
    proofRead();
    return observed;
  });
  let sendBody: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      sendBody = controller;
    },
  });
  const init: RequestInit = overlapCast({
    method: "PUT",
    headers: {
      authorization: `Bearer ${person.accessToken}`,
      "content-type": "application/json",
      "content-length": "16",
    },
    body,
    duplex: "half",
  });
  try {
    const pending = app.request(
      `http://localhost/v1/organizations/${organizationId}/scim/mappings/operators`,
      init,
    );
    await proofObserved;
    await ctx.stores.organizationMemberships.upsert({
      ...membership,
      role: "member",
    });
    if (!sendBody) throw new Error("Expected streaming request body");
    sendBody.enqueue(new TextEncoder().encode('{"role":"owner"}'));
    sendBody.close();
    const response = await pending;
    expect(response.status).toBe(403);
    expect(
      await ctx.stores.scim.mappings.get(organizationId, "operators"),
    ).toBeUndefined();
    await ctx.stores.organizationMemberships.upsert(membership);
    const allowed = await app.request(
      `/v1/organizations/${organizationId}/scim/mappings/operators`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${person.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ role: "owner" }),
      },
    );
    expect(allowed.status).toBe(200);
    expect(
      await ctx.stores.scim.mappings.get(organizationId, "operators"),
    ).toBe("owner");
  } finally {
    vi.restoreAllMocks();
    await plane.withdrawalRecovery.stop();
  }
});
