import { createHash, createHmac, scryptSync } from "node:crypto";
import type { PendingFederatedAuth } from "../interactions/federated-pending.js";

/**
 * Builders for pending cookies in the signed formats that preceded v4. The
 * decoder must refuse all of them; these reproduce them byte for byte so the
 * refusal is tested against real old cookies, not guesses.
 */

/**
 * A v3 cookie as main emitted it before v4 (#2823 wire MAC, sealed verifier),
 * frozen from that encoder with the security test's pepper and pending leg.
 */
export const frozenV3Sealed =
  "eyJpc3N1ZXIiOiJodHRwczovL2lzc3Vlci5leGFtcGxlIiwic3RhdGUiOiJzdGF0ZS1leGFtcGxlIiwibm9uY2UiOiJub25jZS1leGFtcGxlIiwia2luZCI6Im9pZGMiLCJwcm92aWRlcklkIjoicHJvdmlkZXItZXhhbXBsZSIsImJ5b0lkIjoiYnlvLWV4YW1wbGUiLCJvcmdJZCI6Im9yZy1leGFtcGxlIiwidmVyaWZpZXJFbmMiOiJNNE50eVFsSWFFX05peHItRlBPa0NxU0k0RU1vY2JOR05kX2JTRHJBZ0RqYXBxNkxfbTFPb2Rialc2SSJ9.8XAuAdF3JCU5Uim5SJqIaI1rVEaJBTGRmFG7KgqxkNY";

/** The scrypt-bound input every pre-v4 signature covered. */
function legacyInput(value: PendingFederatedAuth, secret: string): string {
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
  return [
    value.issuer,
    value.state,
    value.nonce,
    binding,
    value.kind ?? "oidc",
    value.providerId ?? "",
  ].join("\x1f");
}

export function legacyCookie(
  value: PendingFederatedAuth,
  secret: string,
): string {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  const tag = createHmac("sha256", secret)
    .update(legacyInput(value, secret))
    .digest("base64url");
  return `${payload}.${tag}`;
}

/** The v3 format main emitted before #2823: plaintext verifier on the wire. */
export function plaintextV3Cookie(
  value: PendingFederatedAuth,
  secret: string,
): string {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  const key = createHmac("sha256", secret)
    .update("OpenSesame:federated-pending:v3:key")
    .digest();
  const tag = createHmac("sha256", key)
    .update(
      `OpenSesame:federated-pending:v3\0${payload}\0${legacyInput(value, secret)}`,
    )
    .digest("base64url");
  return `${payload}.${tag}`;
}
