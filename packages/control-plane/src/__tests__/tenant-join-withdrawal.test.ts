import { startReferenceIdp } from "@opensesame/mock-upstream-idp/testkit";
import { isString } from "@opensesame/os-domain";
import { expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";
import { SCIM_ROLE_ATTRIBUTE } from "../routes/scim-effects.js";
import {
  PAGES_ORIGIN,
  joinTenant,
  mintOrgIdToken,
  mintScimToken,
  provisionUser,
  provisional,
  seedTenant,
  testConfig,
} from "./scim-test-helpers.js";

it("returns a retryable response when tenant join cannot finish a role withdrawal", async () => {
  const idp = await startReferenceIdp();
  const plane = createControlPlane({ config: testConfig(idp.issuer) });
  try {
    const { app, ctx } = plane;
    await ctx.securityRecoveryReady;
    const { owner, org } = await seedTenant(app, ctx, "retry-withdrawal", idp);
    if (!isString(owner.accessToken) || !isString(org.id))
      throw new Error("Expected tenant owner");
    const { token } = await mintScimToken(app, org.id, owner.accessToken);
    const initial = await mintOrgIdToken(idp, PAGES_ORIGIN);
    const created = await provisionUser(app, org.id, token, {
      userName: "member@example.test",
      externalId: initial.subject,
    });
    expect(created.status).toBe(201);
    if (!isString(created.body.id))
      throw new Error("Expected provisioned user");
    const person = await provisional(app);
    if (!isString(person.accessToken) || !isString(person.principalId))
      throw new Error("Expected provisional session");
    expect(
      (
        await joinTenant(
          app,
          "retry-withdrawal",
          person.accessToken,
          initial.idToken,
        )
      ).status,
    ).toBe(201);

    const user = await ctx.stores.scim.users.getById(org.id, created.body.id);
    if (!user) throw new Error("Expected provisioned user");
    await ctx.stores.scim.users.update({
      ...user,
      raw: { ...user.raw, [SCIM_ROLE_ATTRIBUTE]: "admin" },
    });
    const retry = await mintOrgIdToken(idp, PAGES_ORIGIN);
    const fetch = globalThis.fetch.bind(globalThis);
    vi.spyOn(globalThis, "fetch").mockImplementation((url, init) =>
      String(url).endsWith("/api/v1/sessions/revoke")
        ? Promise.resolve(new Response("unavailable", { status: 503 }))
        : fetch(url, init),
    );
    const response = await joinTenant(
      app,
      "retry-withdrawal",
      person.accessToken,
      retry.idToken,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: "membership_withdrawing",
    });
    const pending = await ctx.stores.organizationMemberships.findVersioned(
      org.id,
      person.principalId,
    );
    expect(pending?.withdrawalId).toBeDefined();
    expect(pending?.membership.role).toBe("member");
  } finally {
    vi.restoreAllMocks();
    await plane.withdrawalRecovery.stop();
    await idp.close();
  }
}, 30_000);
