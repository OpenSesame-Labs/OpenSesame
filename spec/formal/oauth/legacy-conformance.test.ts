import { createHash, createHmac, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  type PendingFederatedAuth,
  decodePending,
} from "../../../packages/control-plane/src/interactions/federated-pending.js";
import { trustMatchesPending } from "../../../packages/control-plane/src/interactions/federated-trust-binding.js";
import type { TrustResolution } from "../../../packages/control-plane/src/interactions/trust.js";

const secret = "local-test-pepper-with-no-production-credentials";
const path = process.env.OPENSESAME_OAUTH_FORMAL_VECTORS;
if (!path)
  throw new Error("Run spec/formal/oauth/verify.sh to generate Lean vectors");
const rows = readFileSync(path, "utf8")
  .trim()
  .split("\n")
  .map((line) => line.split("\t"));
const vectors = rows.filter((row) => row[0] === "legacy");
const provenance = rows.filter((row) => row[0] === "provenance");

it("covers every abstract legacy MAC and provenance case", () => {
  const expected = new Set<string>();
  for (let row = 0; row < 32; row++) {
    const valid = Math.floor(row / 16) % 2;
    const provider = Math.floor(row / 8) % 2;
    const org = Math.floor(row / 4) % 2;
    const byo = Math.floor(row / 2) % 2;
    const unknown = row % 2;
    expected.add([valid, provider, org, byo, unknown].join("/"));
  }
  expect(vectors).toHaveLength(expected.size);
  expect(new Set(vectors.map((row) => row.slice(1, 6).join("/")))).toEqual(
    expected,
  );
  expect(
    vectors.every(
      (row) =>
        row.length === 7 && row[0] === "legacy" && ["0", "1"].includes(row[6]),
    ),
  ).toBe(true);
});

it.each(vectors)(
  "legacy provenance %s %s %s %s %s %s",
  (_kind, valid, provider, org, byo, unknown, expected) => {
    const pending: PendingFederatedAuth & { futurePolicy?: string } = {
      issuer: "https://issuer.example",
      state: "state-example",
      nonce: "nonce-example",
      verifier: "verifier-example",
      kind: "oidc",
    };
    if (provider === "1") pending.providerId = "provider-example";
    if (org === "1") pending.orgId = "org-example";
    if (byo === "1") pending.byoId = "byo-example";
    if (unknown === "1") pending.futurePolicy = "unbound";
    const payload = Buffer.from(JSON.stringify(pending)).toString("base64url");
    const salt = createHash("sha256")
      .update(secret)
      .update("\0opensesame:fed-pending-verifier\0")
      .update(pending.state)
      .update(pending.nonce)
      .digest()
      .subarray(0, 16);
    const binding = scryptSync(pending.verifier, salt, 32, {
      N: 32768,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    }).toString("base64url");
    const message = [
      pending.issuer,
      pending.state,
      pending.nonce,
      binding,
      pending.kind,
      pending.providerId ?? "",
    ].join("\x1f");
    const tag = createHmac("sha256", valid === "1" ? secret : "wrong-test-key")
      .update(message)
      .digest("base64url");
    // v4 refuses every pre-v4 tag: verifying one would run scrypt on
    // unauthenticated input. The implementation therefore refines the model
    // conservatively. It never accepts a case the model refuses, and it also
    // refuses the model's admitted legacy static-provider cases (FED-I2).
    const accepted = decodePending(`${payload}.${tag}`, secret) !== undefined;
    expect(accepted && expected !== "1").toBe(false);
    expect(accepted).toBe(false);
  },
);

it("covers every sampled source and pending provenance combination", () => {
  expect(provenance).toHaveLength(81);
  expect(new Set(provenance.map((row) => row.slice(1, 5).join("/"))).size).toBe(
    81,
  );
  expect(provenance.every((row) => row.length === 6)).toBe(true);
});

it.each(provenance)(
  "current provenance %s %s %s %s %s",
  (_kind, source, provider, byo, org, expected) => {
    const pending: PendingFederatedAuth = {
      issuer: "https://issuer.example",
      state: "state",
      nonce: "nonce",
      verifier: "verifier",
      kind: "oidc",
    };
    if (provider !== "-") pending.providerId = provider;
    if (byo !== "-") pending.byoId = byo;
    if (org !== "-") pending.orgId = org;
    const trust: TrustResolution =
      source === "0"
        ? {
            source: "static",
            provider: {
              id: "1",
              kind: "oidc",
              label: "Provider",
              issuer: pending.issuer,
              clientAuth: "none",
              scopes: "openid",
            },
          }
        : source === "1"
          ? {
              source: "byo",
              record: {
                id: "1",
                issuer: pending.issuer,
                label: "Provider",
                clientId: "client",
                clientAuth: "none",
                registrationSource: "manual",
                state: "active",
                createdAt: new Date(0),
              },
            }
          : {
              source: "org",
              organizationId: "1",
              issuer: pending.issuer,
              method: "sso",
            };
    expect(trustMatchesPending(trust, pending)).toBe(expected === "1");
  },
);
