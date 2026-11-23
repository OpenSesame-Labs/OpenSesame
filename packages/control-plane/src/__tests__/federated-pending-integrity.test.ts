import { expect, it } from "vitest";
import {
  type PendingFederatedAuth,
  decodePending,
  encodePending,
} from "../interactions/federated-pending.js";
import { legacyCookie } from "./federated-pending-formats.test-support.js";

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

it("refuses every pre-v4 legacy signature, whatever its provenance", () => {
  // Checking a legacy tag meant running scrypt on attacker input before
  // authentication, so no legacy cookie continues; its sign-in restarts.
  for (const value of [
    pending,
    { ...pending, providerId: "provider" },
    { ...pending, providerId: "provider", orgId: "org-a" },
    { ...pending, providerId: "provider", byoId: "byo-a" },
  ])
    expect(decodePending(legacyCookie(value, secret), secret)).toBeUndefined();
});

it("cannot reinterpret a v4 signature over a field-smuggled payload", () => {
  const signed = encodePending(pending, secret);
  const pieces = signed.split(".");
  const payload = pieces.at(-2);
  const tag = pieces.at(-1);
  if (!payload || !tag) throw new Error("expected signed pending cookie");
  // A legacy field can contain the modern input prefix. Different signing
  // keys, rather than a prefix in the message alone, prevent this downgrade.
  const issuer = `OpenSesame:federated-pending:v4\0${payload}\0${pending.issuer}`;
  const forged = Buffer.from(JSON.stringify({ ...pending, issuer })).toString(
    "base64url",
  );
  expect(decodePending(`${forged}.${tag}`, secret)).toBeUndefined();
});
