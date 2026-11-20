import { createHash, scrypt, scryptSync } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

const FINGERPRINT_SALT = createHash("sha256")
  .update("OpenSesame:connect-token-fingerprint")
  .digest()
  .subarray(0, 16);

const FINGERPRINT_SCRYPT = {
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 32 * 1024 * 1024,
};

function fingerprintHex(derived) {
  return derived.toString("hex").slice(0, 12);
}

/** Short display fingerprint for issued tokens; never logged or returned whole. */
export async function fingerprintOf(token) {
  const derived = await scryptAsync(
    token,
    FINGERPRINT_SALT,
    16,
    FINGERPRINT_SCRYPT,
  );
  return fingerprintHex(derived);
}

/** Sync fingerprint for tests and offline gates; avoid on request hot paths. */
export function fingerprintOfSync(token) {
  return fingerprintHex(
    scryptSync(token, FINGERPRINT_SALT, 16, FINGERPRINT_SCRYPT),
  );
}
