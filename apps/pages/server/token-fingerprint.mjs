import { createHash, scryptSync } from "node:crypto";

const FINGERPRINT_SALT = createHash("sha256")
  .update("OpenSesame:connect-token-fingerprint")
  .digest()
  .subarray(0, 16);

/** Short display fingerprint for issued tokens; never logged or returned whole. */
export function fingerprintOf(token) {
  return scryptSync(token, FINGERPRINT_SALT, 16, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 32 * 1024 * 1024,
  })
    .toString("hex")
    .slice(0, 12);
}