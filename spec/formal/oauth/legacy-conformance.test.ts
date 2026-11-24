import { createHash, createHmac, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  type PendingCookieKeys,
  type PendingFederatedAuth,
  decodePending,
  encodePending,
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
const v4 = rows.filter((row) => row[0] === "v4");

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
    // FED-I2 (v4): the model refuses every legacy cookie, because its
    // plaintext verifier fails the strict sealed wire shape whatever its tag.
    const accepted = decodePending(`${payload}.${tag}`, secret) !== undefined;
    expect(accepted).toBe(expected === "1");
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

/** Counts derivations; mirrors the real 255-byte leg-binding refusal. */
function countingKeys(): PendingCookieKeys & { calls: number } {
  const keys = {
    calls: 0,
    verifierSealKey(s: string, state: string, nonce: string): Buffer {
      keys.calls += 1;
      if (Buffer.byteLength(state) > 255 || Buffer.byteLength(nonce) > 255)
        throw new Error("leg binding exceeds 255 bytes");
      return createHash("sha256").update(`${s}\0${state}\0${nonce}`).digest();
    },
  };
  return keys;
}

/** The v4 tag, restated from the reviewed codec so a changed MAC is caught. */
function v4Tag(payload: string, key: string): string {
  const derived = createHmac("sha256", key)
    .update("OpenSesame:federated-pending:v4:key")
    .digest();
  return createHmac("sha256", derived)
    .update("OpenSesame:federated-pending:v4\0")
    .update(payload)
    .digest("base64url");
}

/** Build the signed cookie for one abstract FED-I4 case (keys seal the verifier). */
function v4Cookie(row: string[], keys?: PendingCookieKeys): string {
  const [, oversize, canonicalEncoding, tag, wire, leg, seal] = row;
  const pending: PendingFederatedAuth = {
    issuer: `https://issuer.example/${oversize === "1" ? "a".repeat(5000) : ""}`,
    state: leg === "1" ? "state-example" : "s".repeat(256),
    nonce: "nonce-example",
    verifier: "verifier-example",
    kind: "oidc",
  };
  const { verifier, ...rest } = pending;
  // An over-long leg cannot be sealed; its decode stops at the derivation.
  let verifierEnc = Buffer.alloc(44, 7).toString("base64url");
  if (seal === "1" && leg === "1") {
    const sealedCookie = encodePending(pending, secret, keys);
    const sealedPayload = sealedCookie.slice(0, sealedCookie.lastIndexOf("."));
    verifierEnc = JSON.parse(
      Buffer.from(sealedPayload, "base64url").toString("utf8"),
    ).verifierEnc;
  }
  const sealed = { ...rest, verifierEnc };
  const json =
    wire === "sealed"
      ? sealed
      : wire === "plaintext"
        ? { ...rest, verifier }
        : wire === "mixed"
          ? { ...sealed, verifier }
          : wire === "unknown"
            ? { ...sealed, futurePolicy: "unbound" }
            : undefined;
  let payload = Buffer.from(
    json === undefined ? "{not json" : JSON.stringify(json),
  ).toString("base64url");
  if (canonicalEncoding === "0") payload = `${payload}=`;
  return `${payload}.${v4Tag(payload, tag === "1" ? secret : "wrong-test-key")}`;
}

it("covers every abstract v4 decode case", () => {
  expect(v4).toHaveLength(160);
  expect(new Set(v4.map((row) => row.slice(1, 7).join("/"))).size).toBe(160);
  expect(
    v4.every(
      (row) =>
        row.length === 9 &&
        ["0", "1"].includes(row[7]) &&
        ["0", "1"].includes(row[8]),
    ),
  ).toBe(true);
});

it.each(v4)("v4 decode %s %s %s %s %s %s %s", (...row: string[]) => {
  const [derivations, expected] = [row[7], row[8]];
  // Real keys: acceptance matches the model (FED-I1, FED-I4).
  expect(decodePending(v4Cookie(row), secret) !== undefined).toBe(
    expected === "1",
  );
  // Counted keys: no derivation before the tag verifies, one after.
  const cookie = v4Cookie(row, countingKeys());
  const keys = countingKeys();
  expect(decodePending(cookie, secret, keys) !== undefined).toBe(
    expected === "1",
  );
  expect(keys.calls).toBe(Number(derivations));
});
