import fc from "fast-check";
import { expect, it } from "vitest";
import {
  type PendingFederatedAuth,
  decodePending,
  encodePending,
} from "../interactions/federated-pending.js";

const secret = "federation-test-only-integrity-secret";
const original: PendingFederatedAuth = {
  issuer: "https://idp.example",
  state: "state",
  nonce: "nonce",
  verifier: "verifier",
  kind: "oidc",
  providerId: "provider",
  orgId: "organization",
  byoId: "visitor",
};

it("rejects generated changes to every authenticated federation field", async () => {
  const signed = encodePending(original, secret);
  const tag = signed.split(".")[1];
  if (!tag) throw new Error("expected signed pending cookie");
  const field = fc.constantFrom(
    "issuer",
    "state",
    "nonce",
    "verifier",
    "providerId",
    "orgId",
    "byoId",
  );
  await fc.assert(
    fc.asyncProperty(
      field,
      fc.string({ minLength: 1, maxLength: 24 }),
      async (key, replacement) => {
        fc.pre(replacement !== original[key]);
        const payload = Buffer.from(
          JSON.stringify({ ...original, [key]: replacement }),
        ).toString("base64url");
        expect(decodePending(`${payload}.${tag}`, secret)).toBeUndefined();
      },
    ),
    { numRuns: 40 },
  );
  const switchedKind = Buffer.from(
    JSON.stringify({ ...original, kind: "oauth2" }),
  ).toString("base64url");
  expect(decodePending(`${switchedKind}.${tag}`, secret)).toBeUndefined();
}, 15_000);
