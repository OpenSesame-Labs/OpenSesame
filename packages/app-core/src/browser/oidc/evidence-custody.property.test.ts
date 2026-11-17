import { generateKeyPairSync, sign, webcrypto } from "node:crypto";
import { overlapCast } from "@opensesame/os-domain";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type NativeOidcProof,
  consumeNativeOidcProof,
  verifyNativeOidcProof,
} from "./claims.js";

const issuer = "https://idp.example.test";
const clientId = "evidence-client";
const nonce = "evidence-nonce";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicKey = {
  ...keys.publicKey.export({ format: "jwk" }),
  kid: "evidence-key",
  alg: "RS256",
};

function token(now: number) {
  const encoded = [
    { alg: "RS256", kid: "evidence-key", typ: "JWT" },
    {
      iss: issuer,
      aud: clientId,
      sub: "evidence-subject",
      iat: Math.floor(now / 1000),
      exp: Math.floor(now / 1000) + 120,
      nonce,
    },
  ]
    .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
    .join(".");
  return `${encoded}.${sign("RSA-SHA256", Buffer.from(encoded), keys.privateKey).toString("base64url")}`;
}

async function evidence(now: number) {
  let current = true;
  let onCheck = () => {};
  const controller = new AbortController();
  const proof = await verifyNativeOidcProof({
    token: token(now),
    issuer,
    clientId,
    nonce,
    jwksUri: `${issuer}/jwks`,
    organization: null,
    fetchImpl: async () => Response.json({ keys: [publicKey] }),
    owner: {
      signal: controller.signal,
      assertCurrent: () => {
        if (!current) throw new Error("Original owner retired");
        onCheck();
      },
    },
  });
  return {
    proof,
    expiresAt: (Math.floor(now / 1000) + 120) * 1000,
    setCurrent: (value: boolean) => {
      current = value;
    },
    onCheck: (callback: () => void) => {
      onCheck = callback;
    },
  };
}

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("native OIDC evidence custody", () => {
  it("matches one-use custody across generated attempts and changes of owner and time", async () => {
    const actualTime = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(actualTime);
    const coverage = {
      accepted: 0,
      retired: 0,
      expired: 0,
      replay: 0,
      forged: 0,
    };
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.constantFrom(
            "consume",
            "forged",
            "retire",
            "restore",
            "expire",
            "rewind",
          ),
          { minLength: 1, maxLength: 18 },
        ),
        async (operations) => {
          clock.mockReturnValue(actualTime);
          const instance = await evidence(actualTime);
          const forged: NativeOidcProof = overlapCast({});
          let present = true;
          let current = true;
          let fresh = true;
          for (const operation of operations) {
            if (operation === "retire" || operation === "restore") {
              current = operation === "restore";
              instance.setCurrent(current);
            } else if (operation === "expire" || operation === "rewind") {
              fresh = operation === "rewind";
              clock.mockReturnValue(fresh ? actualTime : instance.expiresAt);
            } else if (operation === "forged") {
              coverage.forged++;
              expect(() => consumeNativeOidcProof(forged)).toThrow(/Unknown/);
            } else {
              const wasPresent = present;
              present = false;
              if (!wasPresent) {
                coverage.replay++;
                expect(() => consumeNativeOidcProof(instance.proof)).toThrow(
                  /already consumed/,
                );
              } else if (!current) {
                coverage.retired++;
                expect(() => consumeNativeOidcProof(instance.proof)).toThrow(
                  /retired/,
                );
              } else if (!fresh) {
                coverage.expired++;
                expect(() => consumeNativeOidcProof(instance.proof)).toThrow(
                  /expired/,
                );
              } else {
                coverage.accepted++;
                expect(
                  consumeNativeOidcProof(instance.proof).claims,
                ).toMatchObject({
                  issuer,
                  audience: clientId,
                  subject: "evidence-subject",
                });
              }
            }
          }
        },
      ),
      { seed: 20261117, numRuns: 80 },
    );
    for (const [name, count] of Object.entries(coverage))
      expect(count, `generated operations must cover ${name}`).toBeGreaterThan(
        0,
      );
  });

  it("consumes evidence before a reentrant owner check", async () => {
    const instance = await evidence(Date.now());
    let reentered = false;
    instance.onCheck(() => {
      reentered = true;
      expect(() => consumeNativeOidcProof(instance.proof)).toThrow(
        /already consumed/,
      );
    });
    expect(consumeNativeOidcProof(instance.proof).claims.subject).toBe(
      "evidence-subject",
    );
    expect(reentered).toBe(true);
  });
});
