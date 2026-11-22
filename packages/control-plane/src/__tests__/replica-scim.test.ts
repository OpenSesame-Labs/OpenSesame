import { PGlite } from "@electric-sql/pglite";
import * as schema from "@opensesame/database/schema";
import {
  type ReferenceIdp,
  startReferenceIdp,
} from "@opensesame/mock-upstream-idp/testkit";
import { overlapCast } from "@opensesame/os-domain";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import {
  DEFAULT_IDP_SUBJECT,
  PAGES_ORIGIN,
  installHostRevocationMock,
  joinTenant,
  mintOrgIdToken,
  mintScimToken,
  patchScim,
  provisionUser,
  provisional,
  seedTenant,
  testConfig,
  usersPath,
} from "./scim-test-helpers.js";

let idp: ReferenceIdp;
let client: PGlite | undefined;

beforeAll(async () => {
  idp = await startReferenceIdp();
}, 30_000);

afterAll(async () => {
  await idp.close();
});

afterEach(async () => {
  await client?.close();
  client = undefined;
});

describe("J-REPLICA SCIM cleanup", () => {
  it("completes deprovision on a second Identity instance sharing stores", async () => {
    const host = installHostRevocationMock();
    try {
      client = new PGlite();
      const db = drizzle(client, { schema });
      await migrate(db, {
        migrationsFolder: new URL(
          "../../../../packages/database/drizzle",
          import.meta.url,
        ).pathname,
      });
      const options = {
        database: overlapCast(db),
        // Postgres stores over the shared database, so both instances share
        // durable membership/SCIM state and the organization boundary can take
        // the same-backend path (DurableMap sessions + Postgres rows).
        config: {
          ...testConfig(idp.issuer),
          claimPepper: "replica-test-only-claim-pepper-32chars",
        },
      };
      const first = createControlPlane(options);
      const second = createControlPlane(options);
      await Promise.all([
        first.ctx.systemPrincipalReady,
        second.ctx.systemPrincipalReady,
      ]);

      const { owner, org } = await seedTenant(
        first.app,
        first.ctx,
        "replica-scim",
        idp,
      );
      const { token } = await mintScimToken(
        first.app,
        org.id,
        owner.accessToken,
      );
      idp.setSubject("replica-scim-user");
      const { idToken, subject } = await mintOrgIdToken(idp, PAGES_ORIGIN);
      idp.setSubject(DEFAULT_IDP_SUBJECT);
      const created = await provisionUser(first.app, org.id, token, {
        userName: "ada@replica.example",
        externalId: subject,
      });
      expect(created.status).toBe(201);
      const guest = await provisional(first.app);
      expect(
        (
          await joinTenant(
            first.app,
            "replica-scim",
            guest.accessToken,
            idToken,
          )
        ).status,
      ).toBe(201);

      const deactivated = await patchScim(
        first.app,
        usersPath(org.id, `/${created.body.id}`),
        token,
        [{ op: "replace", path: "active", value: false }],
      );
      expect(deactivated.status).toBe(200);

      expect(
        await second.ctx.stores.organizationMemberships.find(
          org.id,
          guest.principalId,
        ),
      ).toBeUndefined();
      const stillSignedIn = await second.app.request("/v1/organizations", {
        headers: { authorization: `Bearer ${guest.accessToken}` },
      });
      expect(stillSignedIn.status).toBe(200);
    } finally {
      host.mockRestore();
    }
  }, 30_000);
});
