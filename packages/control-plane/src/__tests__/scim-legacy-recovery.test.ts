import { randomUUID } from "node:crypto";
import type { ScimUserRecord } from "@opensesame/database";
import * as schema from "@opensesame/database/schema";
import { type Organization, overlapCast } from "@opensesame/os-domain";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { z } from "zod";
import { createControlPlane } from "../create-app.js";
import { saveProvisional } from "../repos/session-storage.js";
import {
  SCIM_DEPROVISION_JOURNAL_ATTRIBUTE,
  SCIM_DEPROVISION_PRINCIPALS_ATTRIBUTE,
  deprovisionJournal,
} from "../routes/scim-effects.js";
import { patchScimUser } from "../routes/scim-user-mutations.js";
import { attachVerifiedExternalIdentity } from "../services/identity-link.js";
import { resumePendingOrganizationWithdrawals } from "../services/organization-withdrawal.js";
import { resumePendingScimDeprovision } from "../services/scim-deprovision-recovery.js";
import { migratedPGlite, warmMigratedPGlite } from "./migrated-pglite.js";
import {
  expectInvalidJournalFailsClosed,
  expectRecoveryRollback,
} from "./scim-legacy-recovery-rollback-helper.js";

/** Whether a deprovisioned user's journal shows its first target finished. */
function firstTargetCompleted(user: ScimUserRecord | undefined) {
  return user ? deprovisionJournal(user)?.targets[0]?.completed : undefined;
}

vi.setConfig({ testTimeout: 60_000 });
beforeAll(warmMigratedPGlite, 60_000);
afterEach(() => vi.restoreAllMocks());

it("fences legacy users before readiness and resumes both crash windows after a Host outage", async () => {
  const client = await migratedPGlite();
  try {
    const database = drizzle(client, { schema });
    const options = {
      database: overlapCast(database),
      config: {
        port: 0,
        publicUrl: "http://localhost",
        issuer: "http://localhost",
        claimPepper: "scim-legacy-recovery-test-pepper-32-characters",
      },
    };
    const first = createControlPlane(options);
    await first.ctx.securityRecoveryReady;
    await first.withdrawalRecovery.stop();
    const mint = async () => {
      const response = await first.app.request("/v1/principals/provisional", {
        method: "POST",
      });
      expect(response.status).toBe(201);
      return z
        .object({
          principalId: z.string(),
          sessionId: z.string(),
          accessToken: z.string(),
        })
        .parse(await response.json());
    };
    const beforeMarker = await mint();
    const afterRemoval = await mint();
    const repairedLegacy = await mint();
    const unrelated = await mint();
    const now = first.ctx.clock();
    const deletedPrincipal = {
      principalId: `prn_${randomUUID()}`,
      sessionId: `ses_${randomUUID()}`,
      accessToken: `pst_${randomUUID()}`,
    };
    await first.ctx.repos.principals.create({
      id: deletedPrincipal.principalId,
      state: "provisional",
      assurance: "provisional",
      createdAt: now,
      updatedAt: now,
      version: 1,
    });
    const template = await first.ctx.stores.provisionalSessions.get(
      beforeMarker.sessionId,
    );
    if (!template) throw new Error("Expected a provisional session");
    await saveProvisional(
      first.ctx.stores,
      {
        ...template,
        id: deletedPrincipal.sessionId,
        principalId: deletedPrincipal.principalId,
      },
      deletedPrincipal.accessToken,
    );
    const issuer = "https://legacy-recovery-idp.example";
    const organization: Organization = {
      id: "org:legacy-recovery",
      slug: "legacy-recovery",
      displayName: "Legacy",
      state: "active",
      createdBy: beforeMarker.principalId,
      createdAt: now,
      updatedAt: now,
      ssoIssuer: issuer,
      provisioningEnabled: true,
    };
    const other: Organization = {
      ...organization,
      id: "org:legacy-other",
      slug: "legacy-other",
      createdBy: unrelated.principalId,
      ssoIssuer: "https://other-recovery-idp.example",
    };
    await first.ctx.stores.organizations.set(organization.id, organization);
    await first.ctx.stores.organizations.set(other.id, other);
    for (const [principal, org] of [
      [beforeMarker, organization],
      [repairedLegacy, organization],
      [unrelated, other],
    ] as const) {
      await first.ctx.stores.organizationMemberships.upsert({
        organizationId: org.id,
        principalId: principal.principalId,
        role: "member",
        createdAt: now,
        updatedAt: now,
      });
    }
    const legacyIncarnation = "00000000-0000-4000-8000-000000000001";
    const legacyRevision = "00000000-0000-4000-8000-000000000002";
    await database
      .update(schema.organizationMemberships)
      .set({
        incarnation: legacyIncarnation,
        authorityRevision: legacyRevision,
      })
      .where(
        and(
          eq(schema.organizationMemberships.organizationId, organization.id),
          eq(
            schema.organizationMemberships.principalId,
            repairedLegacy.principalId,
          ),
        ),
      );
    await first.ctx.stores.scim.users.create({
      id: "legacy-repaired",
      organizationId: organization.id,
      userName: "legacy-repaired",
      active: false,
      createdAt: now,
      updatedAt: now,
      raw: {
        [SCIM_DEPROVISION_JOURNAL_ATTRIBUTE]: {
          cycle: randomUUID(),
          targets: [
            {
              principalId: repairedLegacy.principalId,
              incarnation: legacyIncarnation,
              completed: false,
            },
          ],
        },
      },
    });
    for (const [principal, subject] of [
      [beforeMarker, "legacy-before"],
      [afterRemoval, "legacy-after"],
    ] as const) {
      expect(
        (
          await attachVerifiedExternalIdentity(
            first.ctx,
            principal.principalId,
            {
              kind: "oidc",
              issuer,
              subject,
              correlationId: "legacy-test",
            },
          )
        ).ok,
      ).toBe(true);
      await first.ctx.stores.scim.users.create({
        id: subject,
        organizationId: organization.id,
        userName: subject,
        externalId: subject,
        active: false,
        createdAt: now,
        updatedAt: now,
        raw:
          principal === afterRemoval
            ? {
                [SCIM_DEPROVISION_PRINCIPALS_ATTRIBUTE]: [
                  principal.principalId,
                ],
              }
            : {},
      });
    }
    await expectRecoveryRollback(first, organization, beforeMarker.principalId);
    expect(
      await first.ctx.repos.principals.deleteUnlinkedProvisional(
        deletedPrincipal.principalId,
      ),
    ).toBe(true);
    await first.ctx.stores.scim.users.create({
      id: "legacy-orphan",
      organizationId: organization.id,
      userName: "legacy-orphan",
      active: false,
      createdAt: now,
      updatedAt: now,
      raw: {
        [SCIM_DEPROVISION_PRINCIPALS_ATTRIBUTE]: [deletedPrincipal.principalId],
      },
    });
    let available = false;
    const requests: Array<{
      organization_id: string;
      principal_id: string;
      membership_incarnation: string;
    }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: available ? 204 : 503 });
    });
    const restarted = createControlPlane(options);
    await restarted.ctx.securityRecoveryReady;
    await restarted.withdrawalRecovery.firstPass;
    await restarted.withdrawalRecovery.stop();
    const scan = vi.spyOn(
      restarted.ctx.stores.scim.users,
      "listInactiveForRecovery",
    );
    expect(
      (
        await restarted.ctx.stores.organizationMemberships.findVersioned(
          organization.id,
          beforeMarker.principalId,
        )
      )?.withdrawal?.kind,
    ).toBe("remove");
    expect(
      (
        await restarted.ctx.stores.organizationMemberships.findVersioned(
          organization.id,
          repairedLegacy.principalId,
        )
      )?.withdrawal?.kind,
    ).toBe("remove");
    expect(
      await restarted.ctx.stores.organizationMemberships.find(
        organization.id,
        afterRemoval.principalId,
      ),
    ).toBeUndefined();
    for (const principal of [beforeMarker, afterRemoval]) {
      expect(
        (
          await restarted.app.request("/v1/principals/me", {
            headers: { authorization: `Bearer ${principal.accessToken}` },
          })
        ).status,
      ).toBe(401);
    }
    expect(
      await restarted.ctx.stores.organizationMemberships.find(
        organization.id,
        deletedPrincipal.principalId,
      ),
    ).toBeUndefined();
    expect(
      (
        await restarted.ctx.stores.provisionalSessions.get(
          deletedPrincipal.sessionId,
        )
      )?.revokedAt,
    ).toBeDefined();
    expect(
      (
        await restarted.app.request("/v1/principals/me", {
          headers: { authorization: `Bearer ${unrelated.accessToken}` },
        })
      ).status,
    ).toBe(200);
    expect(
      await restarted.ctx.stores.organizationMemberships.find(
        other.id,
        unrelated.principalId,
      ),
    ).toBeDefined();
    await expect(
      patchScimUser(
        restarted.ctx,
        organization,
        "legacy-after",
        { active: true },
        "retry-while-offline",
      ),
    ).rejects.toThrow("Host session revocation is unavailable");
    expect(
      (
        await restarted.ctx.stores.scim.users.getById(
          organization.id,
          "legacy-after",
        )
      )?.active,
    ).toBe(false);
    await restarted.ctx.stores.organizationMemberships.upsert({
      organizationId: organization.id,
      principalId: afterRemoval.principalId,
      role: "member",
      createdAt: now,
      updatedAt: now,
    });
    const freshSession = {
      ...template,
      id: `ses_${randomUUID()}`,
      principalId: afterRemoval.principalId,
    };
    const freshToken = `pst_${randomUUID()}`;
    await saveProvisional(restarted.ctx.stores, freshSession, freshToken);
    available = true;
    expect(await resumePendingOrganizationWithdrawals(restarted.ctx)).toBe(
      false,
    );
    expect(await resumePendingScimDeprovision(restarted.ctx)).toBe(false);
    expect(scan).not.toHaveBeenCalled();
    for (const [principal, subject] of [
      [beforeMarker, "legacy-before"],
      [afterRemoval, "legacy-after"],
    ] as const) {
      const membership =
        await restarted.ctx.stores.organizationMemberships.find(
          organization.id,
          principal.principalId,
        );
      // Only the membership created after the legacy removal survives it.
      expect(membership !== undefined).toBe(principal === afterRemoval);
      expect(
        await restarted.ctx.stores.provisionalTokens.get(principal.accessToken),
      ).toBeUndefined();
      const user = await restarted.ctx.stores.scim.users.getById(
        organization.id,
        subject,
      );
      expect(user?.active).toBe(false);
      expect(firstTargetCompleted(user)).toBe(true);
    }
    expect(await restarted.ctx.stores.provisionalTokens.get(freshToken)).toBe(
      freshSession.id,
    );
    expect(
      (await restarted.ctx.stores.provisionalSessions.get(freshSession.id))
        ?.revokedAt,
    ).toBeUndefined();
    expect(
      await restarted.ctx.stores.organizationMemberships.find(
        organization.id,
        repairedLegacy.principalId,
      ),
    ).toBeUndefined();
    expect(
      requests.some(
        (request) =>
          request.principal_id === repairedLegacy.principalId &&
          request.membership_incarnation === legacyIncarnation,
      ),
    ).toBe(true);
    const orphan = await restarted.ctx.stores.scim.users.getById(
      organization.id,
      "legacy-orphan",
    );
    expect(firstTargetCompleted(orphan)).toBe(true);
    expect(
      await restarted.ctx.stores.provisionalTokens.get(
        deletedPrincipal.accessToken,
      ),
    ).toBeUndefined();
    expect(requests.length).toBeGreaterThan(0);
    expect(
      requests.every(
        (request) =>
          request.organization_id === organization.id &&
          request.principal_id !== unrelated.principalId,
      ),
    ).toBe(true);
    await expectInvalidJournalFailsClosed(first, options, organization, now);
  } finally {
    await client.close();
  }
});
