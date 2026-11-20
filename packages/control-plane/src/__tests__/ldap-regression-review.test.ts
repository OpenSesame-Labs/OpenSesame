import { createHash, randomBytes } from "node:crypto";
import {
  type ReferenceLdapServer,
  startReferenceLdapServer,
} from "@opensesame/mock-upstream-idp/ldap-server";
import type { OrgLdapConfig } from "@opensesame/os-domain";
import { overlapCast } from "@opensesame/os-domain";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { syncLdapDirectory } from "../interactions/ldap.js";
import { resetLdapAttemptBudget } from "../routes/interactions-ldap.js";
import type { startServer } from "../server.js";
import { onFreePort } from "./free-port.js";
import { hopUrl } from "./upstream-hop.js";

/**
 * Directory sync — the pull twin of SCIM push (D17), against a real directory.
 *
 * The whole point of a sync is what it does to people who are no longer there,
 * so the leaver case is the one that matters: tenant authority disappears,
 * while the principal-wide Identity session remains valid for unrelated
 * tenants and personal work.
 */

type Started = Awaited<ReturnType<typeof startServer>>;

const BASE_DN = "dc=acme,dc=example";
const PEOPLE_DN = `ou=people,${BASE_DN}`;
const ENGINEERS_DN = `cn=engineers,ou=groups,${BASE_DN}`;
const LEADS_DN = `cn=leads,ou=groups,${BASE_DN}`;
const ORG_ID = "org:ldap-sync";
const SLUG = "sync-acme";
const RP_ORIGIN = "http://127.0.0.1:4341";

function secret(): string {
  return randomBytes(24).toString("base64url");
}

class Jar {
  private cookies = new Map<string, string>();

  absorb(res: Response): void {
    for (const sc of res.headers.getSetCookie()) {
      const pair = sc.split(";")[0] ?? "";
      const idx = pair.indexOf("=");
      if (idx <= 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (value) this.cookies.set(name, value);
      else this.cookies.delete(name);
    }
  }

  header() {
    if (this.cookies.size === 0) return {};
    return {
      cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    };
  }
}

describe("LDAP directory sync", () => {
  let directory: ReferenceLdapServer;
  let started: Started;
  let base: string;
  const servicePassword = secret();
  const carolPassword = secret();
  const danPassword = secret();
  const carolUuid = randomBytes(16).toString("hex");
  const danUuid = randomBytes(16).toString("hex");

  function config(): OrgLdapConfig {
    return {
      organizationId: ORG_ID,
      url: directory.url,
      // Search-bind, because a sync has no user password to bind with and
      // therefore always needs the service account.
      bindMode: "search_bind",
      searchBaseDn: PEOPLE_DN,
      searchFilter: "(uid={username})",
      serviceBindDn: `cn=service,${BASE_DN}`,
      serviceBindSecret: servicePassword,
      subjectAttribute: "entryUUID",
      attributeMap: { email: "mail", name: "cn" },
      groupRoleMap: { engineers: "member", [LEADS_DN]: "owner" },
    };
  }

  function personEntry(
    uid: string,
    uuid: string,
    password: string,
    groups: string[],
  ) {
    return {
      dn: `uid=${uid},${PEOPLE_DN}`,
      password,
      attributes: {
        objectClass: ["inetOrgPerson"],
        uid: [uid],
        cn: [`${uid} Example`],
        mail: [`${uid}@acme.example`],
        entryUUID: [uuid],
        memberOf: groups,
      },
    };
  }

  beforeAll(async () => {
    directory = await startReferenceLdapServer({
      baseDn: BASE_DN,
      entries: [
        {
          dn: `cn=service,${BASE_DN}`,
          password: servicePassword,
          attributes: { objectClass: ["applicationProcess"], cn: ["service"] },
        },
        personEntry("carol", carolUuid, carolPassword, [ENGINEERS_DN]),
        personEntry("dan", danUuid, danPassword, [ENGINEERS_DN]),
      ],
    });

    const { startServer: start } = await import("../server.js");
    started = await onFreePort((port) =>
      start({
        config: {
          host: "127.0.0.1",
          port,
          publicUrl: `http://127.0.0.1:${port}`,
          issuer: `http://127.0.0.1:${port}`,
        },
        processEnv: {
          ...process.env,
          OPENSESAME_ORIGIN_CLIENTS_ENABLED: "true",
        },
      }),
    );
    base = `http://127.0.0.1:${started.port}`;

    const now = started.ctx.clock();
    await started.ctx.stores.organizations.set(ORG_ID, {
      id: ORG_ID,
      slug: SLUG,
      displayName: "Sync Acme",
      state: "active",
      createdBy: "prn_seed",
      createdAt: now,
      updatedAt: now,
    });
    await started.ctx.stores.orgFederation.ldapConfigs.put(config());
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      started.server.close((err) => (err ? reject(err) : resolve())),
    );
    await directory.close();
  });

  afterEach(() => {
    resetLdapAttemptBudget();
  });

  async function req(jar: Jar, path: string, init: RequestInit = {}) {
    const res = await fetch(path.startsWith("http") ? path : `${base}${path}`, {
      redirect: "manual",
      ...init,
      headers: { ...jar.header(), ...overlapCast(init.headers) },
    });
    jar.absorb(res);
    return res;
  }

  /** A real sign-in: the only way a directory entry becomes a principal. */
  async function signIn(username: string, password: string) {
    const jar = new Jar();
    const verifier = randomBytes(32).toString("base64url");
    const params = new URLSearchParams({
      client_id: `origin:${RP_ORIGIN}`,
      redirect_uri: `${RP_ORIGIN}/opensesame/callback`,
      response_type: "code",
      scope: "openid",
      state: "s-1",
      nonce: "n-1",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    const authorize = await req(jar, `/auth?${params.toString()}`);
    const location = authorize.headers.get("location") ?? "";
    const uid = location.slice("/interaction/".length);
    // The directory form, and its single-use token, come from the login page
    // the mounted sub-router renders for this tenant.
    const page = await req(jar, `${location}?org=${SLUG}`);
    const csrfMatch = (await page.text()).match(/name="_csrf" value="([^"]+)"/);
    if (!csrfMatch?.[1]) throw new Error("no csrf token in page");

    const completed = await req(jar, `/interaction/${uid}/federated/ldap`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: csrfMatch[1],
        slug: SLUG,
        username,
        password,
      }),
    });
    expect(await hopUrl(completed)).toContain("/auth/");
    const cookie = completed.headers
      .getSetCookie()
      .find((value) => value.startsWith("os_provisional="));
    if (!cookie) throw new Error("no provisional session issued");
    const accessToken = (cookie.split(";")[0] ?? "").slice(
      "os_provisional=".length,
    );

    const subject = username === "carol" ? carolUuid : danUuid;
    const identity = await started.ctx.repos.externalIdentities.findByTuple({
      kind: "ldap",
      issuer: directory.url,
      subject,
    });
    if (!identity) throw new Error("no identity linked");
    return { principalId: identity.principalId, accessToken };
  }

  it("regression review: inactive authoritative SCIM subject is not rejoined", async () => {
    const { principalId } = await signIn("carol", carolPassword);
    const ctx = started.ctx;
    const org = await ctx.stores.organizations.get(ORG_ID);
    if (!org) throw new Error("missing org");
    const now = ctx.clock();
    await ctx.stores.scim.users.create({
      id: "inactive-ldap-regression-review",
      organizationId: ORG_ID,
      userName: carolUuid,
      externalId: carolUuid,
      active: false,
      raw: {},
      createdAt: now,
      updatedAt: now,
    });
    await ctx.stores.organizations.set(ORG_ID, {
      ...org,
      provisioningEnabled: true,
    });
    await ctx.stores.organizationMemberships.remove(ORG_ID, principalId);
    try {
      await syncLdapDirectory(ctx, config());
      expect(
        await ctx.stores.organizationMemberships.find(ORG_ID, principalId),
      ).toBeUndefined();
    } finally {
      await ctx.stores.organizations.set(ORG_ID, org);
      await ctx.stores.organizationMemberships.remove(ORG_ID, principalId);
    }
  });

  it("regression review: stale LDAP observation cannot withdraw re-created membership", async () => {
    const { principalId } = await signIn("dan", danPassword);
    const ctx = started.ctx;
    expect(directory.removeEntry(`uid=dan,${PEOPLE_DN}`)).toBe(true);
    const now = ctx.clock();
    const membership = {
      organizationId: ORG_ID,
      principalId,
      role: "member" as const,
      createdAt: now,
      updatedAt: now,
    };
    const original = ctx.repos.externalIdentities.listByPrincipal.bind(
      ctx.repos.externalIdentities,
    );
    let replaced = false;
    const spy = vi
      .spyOn(ctx.repos.externalIdentities, "listByPrincipal")
      .mockImplementation(async (id) => {
        if (id === principalId && !replaced) {
          replaced = true;
          await ctx.stores.organizationMemberships.remove(ORG_ID, id);
          await ctx.stores.organizationMemberships.upsert(membership);
        }
        return original(id);
      });
    const realFetch = globalThis.fetch;
    const host = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        if (String(input).endsWith("/api/v1/sessions/revoke")) {
          const body = JSON.parse(String(init?.body));
          return new Response(
            JSON.stringify({
              durable: true,
              revoked: 1,
              withdrawal_id: body.withdrawal_id,
              membership_incarnation: body.membership_incarnation,
              authority_revision: body.authority_revision,
            }),
            { status: 200 },
          );
        }
        return realFetch(input, init);
      });
    try {
      const summary = await syncLdapDirectory(ctx, config());
      expect(replaced).toBe(true);
      expect(summary.deactivated).toBe(0);
      expect(
        await ctx.stores.organizationMemberships.find(ORG_ID, principalId),
      ).toBeDefined();
    } finally {
      host.mockRestore();
      spy.mockRestore();
      await ctx.stores.organizationMemberships.remove(ORG_ID, principalId);
    }
  });

  it("regression review: LDAP role demotion waits for Host withdrawal", async () => {
    const ctx = started.ctx;
    const identity = await ctx.repos.externalIdentities.findByTuple({
      kind: "ldap",
      issuer: directory.url,
      subject: carolUuid,
    });
    if (!identity) throw new Error("missing Carol identity");
    const now = ctx.clock();
    await ctx.stores.organizationMemberships.upsert({
      organizationId: ORG_ID,
      principalId: identity.principalId,
      role: "admin",
      createdAt: now,
      updatedAt: now,
    });
    const realFetch = globalThis.fetch;
    let hostCalls = 0;
    const host = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        if (String(input).endsWith("/api/v1/sessions/revoke")) {
          hostCalls += 1;
          return new Response("unavailable", { status: 503 });
        }
        return realFetch(input, init);
      });
    try {
      await syncLdapDirectory(ctx, config()).catch(() => undefined);
      const result = await ctx.stores.organizationMemberships.findVersioned(
        ORG_ID,
        identity.principalId,
      );
      expect(hostCalls).toBe(1);
      expect(result?.membership.role).toBe("admin");
      expect(result?.withdrawalId).toBeTruthy();
    } finally {
      host.mockRestore();
    }
  });
});
