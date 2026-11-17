import type { ReferenceLdapServer } from "@opensesame/mock-upstream-idp/ldap-server";
import type { OrgLdapConfig } from "@opensesame/os-domain";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { AppContext } from "../context.js";
import { syncLdapDirectory } from "../interactions/ldap.js";
import { mockHostWithdrawal } from "./host-withdrawal-test-helper.js";

export function registerLdapSyncRaceCases(
  fixtures: () => {
    ctx: AppContext;
    directory: ReferenceLdapServer;
    organizationId: string;
    config: () => OrgLdapConfig;
    carolUuid: string;
    danUuid: string;
  },
): void {
  let host: ReturnType<typeof mockHostWithdrawal>;
  beforeAll(() => {
    host = mockHostWithdrawal(fixtures().ctx);
  });
  afterAll(() => {
    host.restore();
  });
  it("does not remove a membership recreated after the LDAP scan began", async () => {
    const { ctx, directory, organizationId, config, danUuid } = fixtures();
    const identity = await ctx.repos.externalIdentities.findByTuple({
      kind: "ldap",
      issuer: directory.url,
      subject: danUuid,
    });
    if (!identity) throw new Error("Expected Dan's previously linked identity");
    const now = ctx.clock();
    const membership = {
      organizationId: organizationId,
      principalId: identity.principalId,
      role: "member" as const,
      createdAt: now,
      updatedAt: now,
    };
    await ctx.stores.organizationMemberships.upsert(membership);
    const original = ctx.repos.externalIdentities.listByPrincipal.bind(
      ctx.repos.externalIdentities,
    );
    let replaced = false;
    const spy = vi
      .spyOn(ctx.repos.externalIdentities, "listByPrincipal")
      .mockImplementation(async (principalId) => {
        if (principalId === identity.principalId && !replaced) {
          replaced = true;
          await ctx.stores.organizationMemberships.remove(
            organizationId,
            principalId,
          );
          await ctx.stores.organizationMemberships.upsert(membership);
        }
        return original(principalId);
      });
    try {
      const summary = await syncLdapDirectory(ctx, config());
      expect(replaced).toBe(true);
      expect(summary.deactivated).toBe(0);
      expect(
        await ctx.stores.organizationMemberships.find(
          organizationId,
          identity.principalId,
        ),
      ).toBeDefined();
    } finally {
      spy.mockRestore();
      await ctx.stores.organizationMemberships.remove(
        organizationId,
        identity.principalId,
      );
    }
  });

  it("does not rejoin an LDAP subject whose authoritative SCIM user is inactive", async () => {
    const { ctx, directory, organizationId, config, carolUuid } = fixtures();
    const identity = await ctx.repos.externalIdentities.findByTuple({
      kind: "ldap",
      issuer: directory.url,
      subject: carolUuid,
    });
    const org = await ctx.stores.organizations.get(organizationId);
    if (!identity || !org)
      throw new Error("Expected Carol and her organization");
    const membership = await ctx.stores.organizationMemberships.find(
      organizationId,
      identity.principalId,
    );
    if (!membership) throw new Error("Expected Carol's membership");
    const now = ctx.clock();
    await ctx.stores.scim.users.create({
      id: "inactive-ldap-subject",
      organizationId: organizationId,
      userName: carolUuid,
      externalId: carolUuid,
      active: false,
      raw: {},
      createdAt: now,
      updatedAt: now,
    });
    await ctx.stores.organizations.set(organizationId, {
      ...org,
      provisioningEnabled: true,
    });
    await ctx.stores.organizationMemberships.remove(
      organizationId,
      identity.principalId,
    );
    try {
      await syncLdapDirectory(ctx, config());
      expect(
        await ctx.stores.organizationMemberships.find(
          organizationId,
          identity.principalId,
        ),
      ).toBeUndefined();
    } finally {
      await ctx.stores.organizations.set(organizationId, org);
      await ctx.stores.organizationMemberships.upsert(membership);
    }
  });
}
