import { createHash, createHmac, scryptSync } from "node:crypto";
import { expect, it } from "vitest";
import {
  type PendingFederatedAuth,
  decodePending,
  encodePending,
} from "../interactions/federated-pending.js";

const secret = "federation-test-only-integrity-secret";
const pending: PendingFederatedAuth = {
  issuer: "https://idp.example",
  state: "state",
  nonce: "nonce",
  verifier: "verifier",
};

function replacePayload(signed: string, value: PendingFederatedAuth): string {
  const signature = signed.split(".")[1];
  if (!signature) throw new Error("expected signed pending cookie");
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${payload}.${signature}`;
}

function legacyCookie(value: PendingFederatedAuth): string {
  const salt = createHash("sha256")
    .update(secret)
    .update("\0opensesame:fed-pending-verifier\0")
    .update(value.state)
    .update(value.nonce)
    .digest()
    .subarray(0, 16);
  const binding = scryptSync(value.verifier, salt, 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  }).toString("base64url");
  const input = [
    value.issuer,
    value.state,
    value.nonce,
    binding,
    value.kind ?? "oidc",
    value.providerId ?? "",
  ].join("\x1f");
  const signature = createHmac("sha256", secret)
    .update(input)
    .digest("base64url");
  return `${Buffer.from(JSON.stringify(value)).toString("base64url")}.${signature}`;
}

it.each([
  [pending, { ...pending, orgId: "other-org" }],
  [
    { ...pending, orgId: "org-a" },
    { ...pending, orgId: "org-b" },
  ],
  [{ ...pending, orgId: "org-a" }, pending],
  [pending, { ...pending, byoId: "other-byo" }],
  [
    { ...pending, byoId: "byo-a" },
    { ...pending, byoId: "byo-b" },
  ],
  [{ ...pending, byoId: "byo-a" }, pending],
])(
  "rejects changes to signed organization or visitor provenance",
  (original, altered) => {
    const signed = encodePending(original, secret);
    expect(decodePending(signed, secret)).toEqual(original);
    expect(
      decodePending(replacePayload(signed, altered), secret),
    ).toBeUndefined();
  },
);

it("continues old signed cookies only with bound static-provider provenance", () => {
  expect(decodePending(legacyCookie(pending), secret)).toBeUndefined();
  expect(
    decodePending(legacyCookie({ ...pending, providerId: "provider" }), secret),
  ).toEqual({ ...pending, providerId: "provider" });
  expect(
    decodePending(
      legacyCookie({ ...pending, providerId: "provider", orgId: "org-a" }),
      secret,
    ),
  ).toBeUndefined();
  expect(
    decodePending(
      legacyCookie({ ...pending, providerId: "provider", byoId: "byo-a" }),
      secret,
    ),
  ).toBeUndefined();
  expect(
    decodePending(
      replacePayload(legacyCookie({ ...pending, providerId: "provider" }), {
        ...pending,
        providerId: "provider",
        orgId: "org-a",
      }),
      secret,
    ),
  ).toBeUndefined();
  expect(
    decodePending(
      replacePayload(legacyCookie({ ...pending, providerId: "provider" }), {
        ...pending,
        providerId: "provider",
        byoId: "byo-a",
      }),
      secret,
    ),
  ).toBeUndefined();
});

it("cannot reinterpret a modern signature as a legacy signature", () => {
  const signed = encodePending(pending, secret);
  const pieces = signed.split(".");
  const payload = pieces.at(-2);
  const tag = pieces.at(-1);
  if (!payload || !tag) throw new Error("expected signed pending cookie");
  // A legacy field can contain the modern input prefix. Different signing
  // keys, rather than a prefix in the message alone, prevent this downgrade.
  const issuer = `OpenSesame:federated-pending:v3\0${payload}\0${pending.issuer}`;
  const forged = Buffer.from(JSON.stringify({ ...pending, issuer })).toString(
    "base64url",
  );
  expect(decodePending(`${forged}.${tag}`, secret)).toBeUndefined();
});
