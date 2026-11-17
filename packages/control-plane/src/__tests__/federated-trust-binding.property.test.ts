import fc from "fast-check";
import { expect, it } from "vitest";
import type { PendingFederatedAuth } from "../interactions/federated-pending.js";
import { trustMatchesPending } from "../interactions/federated-trust-binding.js";
import type { TrustResolution } from "../interactions/trust.js";

type Source = "static" | "byo" | "org";
type Case = {
  started: Source | "legacy";
  startedId: string;
  current: Source;
  currentId: string;
  pendingKind: "oidc" | "oauth2";
  currentKind: "oidc" | "oauth2";
  extra: Source | "none";
};

const cases: fc.Arbitrary<Case> = fc.record({
  started: fc.constantFrom("static", "byo", "org", "legacy"),
  startedId: fc.constantFrom("a", "b"),
  current: fc.constantFrom("static", "byo", "org"),
  currentId: fc.constantFrom("a", "b"),
  pendingKind: fc.constantFrom("oidc", "oauth2"),
  currentKind: fc.constantFrom("oidc", "oauth2"),
  extra: fc.constantFrom("static", "byo", "org", "none"),
});

function trust(input: Case): TrustResolution {
  if (input.current === "static") {
    return {
      source: "static",
      provider: {
        id: input.currentId,
        kind: input.currentKind,
        label: "Provider",
        issuer: "https://issuer.example",
        clientAuth: "none",
        scopes: "openid",
      },
    };
  }
  if (input.current === "byo") {
    return {
      source: "byo",
      record: {
        id: input.currentId,
        issuer: "https://issuer.example",
        label: "Provider",
        clientId: "client",
        clientAuth: "none",
        registrationSource: "manual",
        state: "active",
        createdAt: new Date(0),
      },
    };
  }
  return {
    source: "org",
    organizationId: input.currentId,
    issuer: "https://issuer.example",
    method: "sso",
  };
}

function pending(input: Case): PendingFederatedAuth {
  const value: PendingFederatedAuth = {
    issuer: "https://issuer.example",
    state: "state",
    nonce: "nonce",
    verifier: "verifier",
    kind: input.pendingKind,
  };
  if (input.started === "static") value.providerId = input.startedId;
  if (input.started === "byo") value.byoId = input.startedId;
  if (input.started === "org") value.orgId = input.startedId;
  if (input.extra === "static") value.providerId = "extra";
  if (input.extra === "byo") value.byoId = "extra";
  if (input.extra === "org") value.orgId = "extra";
  return value;
}

function expected(input: Case, value: PendingFederatedAuth): boolean {
  if (input.pendingKind !== "oidc") return false;
  if (input.current === "static" && input.currentKind !== "oidc") return false;
  const fields = [value.providerId, value.byoId, value.orgId].filter(
    (item) => item !== undefined,
  );
  if (fields.length > 1) return false;
  if (value.providerId !== undefined) {
    return input.current === "static" && value.providerId === input.currentId;
  }
  if (value.byoId !== undefined) {
    return input.current === "byo" && value.byoId === input.currentId;
  }
  if (value.orgId !== undefined) {
    return input.current === "org" && value.orgId === input.currentId;
  }
  return input.current === "static";
}

it("binds generated callbacks to the source and record that started them", () => {
  fc.assert(
    fc.property(cases, (input) => {
      const value = pending(input);
      expect(trustMatchesPending(trust(input), value)).toBe(
        expected(input, value),
      );
    }),
    { numRuns: 500 },
  );
});
