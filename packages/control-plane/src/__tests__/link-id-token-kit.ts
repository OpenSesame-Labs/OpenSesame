import { overlapCast } from "@opensesame/os-domain";
import { exportJWK, generateKeyPair } from "jose";
import { expect } from "vitest";
import type { createControlPlane } from "../create-app.js";

/** Shared fixtures for the id_token link suites. */

export const ISSUER = "http://127.0.0.1:9090";

export async function mintKeys() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "claim-1";
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { privateKey, jwks: { keys: [jwk] } };
}

export async function guest(app: ReturnType<typeof createControlPlane>["app"]) {
  const res = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(res.status).toBe(201);
  return overlapCast(await res.json());
}
