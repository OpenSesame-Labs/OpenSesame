import { type Organization, overlapCast } from "@opensesame/os-domain";
import fc from "fast-check";
import { expect, it } from "vitest";
import { loadConfig } from "../config.js";
import type { AppContext } from "../context.js";
import {
  type ByoUpstream,
  resolveTrustedIssuer,
} from "../interactions/trust.js";

const issuer = "https://issuer.example";
const now = new Date("2025-01-01T00:00:00.000Z");
const organization: Organization = {
  id: "org:1",
  slug: "one",
  displayName: "One",
  state: "active",
  createdBy: "principal",
  createdAt: now,
  updatedAt: now,
  ssoIssuer: issuer,
};
const upstream: ByoUpstream = {
  id: "byo:1",
  issuer,
  label: "Example",
  clientId: "client",
  clientAuth: "none",
  registrationSource: "manual",
  state: "active",
  createdAt: now,
};

const scenario = fc.record({
  staticTrust: fc.boolean(),
  org: fc.constantFrom("absent", "active", "suspended", "deleted"),
  approved: fc.boolean(),
  byo: fc.constantFrom("absent", "active", "disabled"),
  trailingSlashes: fc.integer({ min: 0, max: 5 }),
});

it("resolves generated issuer configurations in operator, organization, visitor order", async () => {
  await fc.assert(
    fc.asyncProperty(scenario, async (input) => {
      const calls: string[] = [];
      const config = {
        ...loadConfig({ OPENSESAME_ALLOW_DEV_DEFAULTS: "1" }),
        providers: [],
        trustedUpstreamIssuers: input.staticTrust ? [issuer] : [],
        organizationIssuerAllowlist: input.approved
          ? [`${organization.id}|${issuer}`]
          : [],
      };
      const ctx: AppContext = overlapCast({
        config,
        stores: {
          organizations: {
            findByIssuer: async (value: string) => {
              calls.push(`org:${value}`);
              return input.org === "absent"
                ? undefined
                : { ...organization, state: input.org };
            },
          },
        },
        repos: {
          byoUpstreams: {
            findByIssuer: async (value: string) => {
              calls.push(`byo:${value}`);
              return input.byo === "absent"
                ? undefined
                : { ...upstream, state: input.byo };
            },
          },
        },
      });
      const result = await resolveTrustedIssuer(
        ctx,
        `  ${issuer}${"/".repeat(input.trailingSlashes)}  `,
      );
      const orgEligible = input.org === "active" && input.approved;
      const expected = input.staticTrust
        ? "static"
        : orgEligible
          ? "org"
          : input.byo === "active"
            ? "byo"
            : undefined;
      expect(result?.source).toBe(expected);
      expect(calls).toEqual(
        input.staticTrust
          ? []
          : orgEligible
            ? [`org:${issuer}`]
            : [`org:${issuer}`, `byo:${issuer}`],
      );
      if (result?.source === "org") {
        expect(result.organizationId).toBe(organization.id);
        expect(result.issuer).toBe(issuer);
      }
    }),
    { numRuns: 400 },
  );
});
