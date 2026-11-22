import * as schema from "@opensesame/database/schema";
import { overlapCast } from "@opensesame/os-domain";
import { drizzle } from "drizzle-orm/pglite";
import { importJWK, jwtVerify } from "jose";
import { beforeAll, expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";
import { fixture } from "./host-authorization-fixture.js";
import { migratedPGlite, warmMigratedPGlite } from "./migrated-pglite.js";

// Each PGlite test here starts its own database. They used to boot one and
// apply every migration inside the test, which on a loaded CI runner took most
// of the package's 15s budget (legacy-agent-durability timed out on it); now
// the migrations run once per file, in the hook below, and each test loads a
// copy (migrated-pglite.ts). The 60s budget stays as the margin for load.
vi.setConfig({ testTimeout: 60_000 });
beforeAll(warmMigratedPGlite, 60_000);

it("uses real UV signatures even with dev defaults, signs the frozen tuple and spends once", async () => {
  const f = await fixture();
  const first = await f.begin();
  expect((await f.verify(f.assertion(first, false))).status).toBe(403);
  const second = await f.begin();
  const body = f.assertion(second);
  const responses = await Promise.all([f.verify(body), f.verify(body)]);
  expect(responses.map((response) => response.status).sort()).toEqual([
    200, 403,
  ]);
  const success = responses.find((response) => response.status === 200);
  if (!success) throw new Error("No winning assertion");
  const signed = await success.json();
  const jwk = f.ctx.oauth.configuration.jwks?.keys[0];
  const { payload, protectedHeader } = await jwtVerify(
    signed.assertion,
    await importJWK(
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256" },
      "RS256",
    ),
    {
      algorithms: ["RS256"],
      issuer: f.config.issuer,
      audience: f.challenge.host_audience,
    },
  );
  expect(protectedHeader.typ).toBe("host-authorization+jwt");
  expect(payload).toMatchObject({
    ...f.challenge,
    sub: f.minted.principalId,
    amr: ["webauthn"],
    assurance: "phishing_resistant",
    organization_role: "owner",
  });
  const membership = await f.ctx.stores.organizationMemberships.findVersioned(
    f.challenge.organization_id,
    f.minted.principalId,
  );
  expect(payload.membership_incarnation).toBe(membership?.incarnation);
  expect(payload.authority_revision).toBe(membership?.authorityRevision);
});

it("refuses caller assurance, unknown audiences, wrong transaction, and removed membership", async () => {
  const f = await fixture();
  for (const extra of [
    { auth_time: 1 },
    { amr: ["webauthn"] },
    { organization_role: "owner" },
  ]) {
    expect(
      (
        await f.app.request("/v1/host-authorizations/options", {
          method: "POST",
          headers: f.headers,
          body: JSON.stringify({ ...f.challenge, ...extra }),
        })
      ).status,
    ).toBe(400);
  }
  for (const override of [
    { host_audience: "https://foreign.example" },
    { transition: null },
    { expires_at: 1 },
    { origin: "https://vault.example/path" },
  ]) {
    expect(
      (
        await f.app.request("/v1/host-authorizations/options", {
          method: "POST",
          headers: f.headers,
          body: JSON.stringify({ ...f.challenge, ...override }),
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
  }
  const one = await f.begin();
  const two = await f.begin();
  expect(
    (
      await f.verify({
        ...f.assertion(one),
        authorization_id: two.authorization_id,
      })
    ).status,
  ).toBe(403);
  await f.ctx.stores.organizationMemberships.remove(
    f.challenge.organization_id,
    f.minted.principalId,
  );
  expect((await f.verify(f.assertion(one))).status).toBe(403);
});

it.each(["provisional", "suspended", "deleted"] as const)(
  "neither starts nor completes Host authorization for a %s organization",
  async (state) => {
    const f = await fixture();
    const id = f.challenge.organization_id;
    const original = await f.ctx.stores.organizations.get(id);
    if (!original) throw new Error("Fixture organization missing");
    const pending = await f.begin();
    await f.ctx.stores.organizations.set(id, { ...original, state });
    const options = await f.app.request("/v1/host-authorizations/options", {
      method: "POST",
      headers: f.headers,
      body: JSON.stringify(f.challenge),
    });
    expect(options.status).toBe(403);
    if (!(f.ctx.stores.hostAuthorizations instanceof Map))
      throw new Error("Expected the in-memory test store");
    expect(f.ctx.stores.hostAuthorizations.size).toBe(1);
    expect((await f.verify(f.assertion(pending))).status).toBe(403);
    expect(
      await f.ctx.stores.hostAuthorizations.get(pending.authorization_id),
    ).toBeUndefined();
    expect(
      (await f.ctx.repos.auditEvents.list({ limit: 100 })).some(
        (event) => event.eventType === "host.authorization.issued",
      ),
    ).toBe(false);
    expect(
      await f.ctx.stores.organizationMemberships.find(id, f.minted.principalId),
    ).toMatchObject({ role: "owner" });

    if (state === "deleted") return;
    await f.ctx.stores.organizations.set(id, original);
    // A refused attempt consumed its challenge and cannot be replayed after
    // reactivation, but a fresh ceremony is allowed.
    expect((await f.verify(f.assertion(pending))).status).toBe(403);
    const fresh = await f.begin();
    expect((await f.verify(f.assertion(fresh, true, 2))).status).toBe(200);
  },
);

it("rechecks liveness after the passkey verifier returns", async () => {
  const f = await fixture();
  const id = f.challenge.organization_id;
  const organization = await f.ctx.stores.organizations.get(id);
  if (!organization) throw new Error("Fixture organization missing");
  const pending = await f.begin();
  const verifier = f.ctx.hostAuthorizationPasskeys.verify.bind(
    f.ctx.hostAuthorizationPasskeys,
  );
  vi.spyOn(f.ctx.hostAuthorizationPasskeys, "verify").mockImplementation(
    async (input) => {
      const result = await verifier(input);
      await f.ctx.stores.organizations.set(id, {
        ...organization,
        state: "suspended",
      });
      return result;
    },
  );
  expect((await f.verify(f.assertion(pending))).status).toBe(403);
});

it("refuses a stale membership whose organization no longer exists", async () => {
  const f = await fixture();
  const pending = await f.begin();
  vi.spyOn(f.ctx.stores.organizations, "get").mockReturnValue(undefined);
  const options = await f.app.request("/v1/host-authorizations/options", {
    method: "POST",
    headers: f.headers,
    body: JSON.stringify(f.challenge),
  });
  expect(options.status).toBe(403);
  expect((await f.verify(f.assertion(pending))).status).toBe(403);
});

it("allows an unspent ceremony after reinstatement when it remains unexpired", async () => {
  const f = await fixture();
  const id = f.challenge.organization_id;
  const organization = await f.ctx.stores.organizations.get(id);
  if (!organization) throw new Error("Fixture organization missing");
  const pending = await f.begin();
  await f.ctx.stores.organizations.set(id, {
    ...organization,
    state: "suspended",
  });
  await f.ctx.stores.organizations.set(id, organization);
  expect((await f.verify(f.assertion(pending))).status).toBe(200);
});

it("verifies a real passkey on another app instance and consumes the pending grant atomically", async () => {
  const client = await migratedPGlite();
  try {
    const db = drizzle(client, { schema });
    const first = await fixture({ database: overlapCast(db) });
    const pending = await first.begin();
    const second = createControlPlane(first.planeOptions);
    const input = first.assertion(pending);
    const results = await Promise.all([
      first.verify(input),
      second.app.request("/v1/host-authorizations/verify", {
        method: "POST",
        headers: first.headers,
        body: JSON.stringify(input),
      }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 403]);
    expect(
      await second.ctx.stores.hostAuthorizations.get(pending.authorization_id),
    ).toBeUndefined();

    // A lifecycle change on one replica must fence completion on the other.
    const later = await first.begin();
    const organization = await second.ctx.stores.organizations.get(
      first.challenge.organization_id,
    );
    if (!organization) throw new Error("Fixture organization missing");
    await second.ctx.stores.organizations.set(organization.id, {
      ...organization,
      state: "suspended",
    });
    expect((await first.verify(first.assertion(later, true, 2))).status).toBe(
      403,
    );
  } finally {
    await client.close();
  }
});
