import { remoteIdentityApi } from "./identity.js";

function trimSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * The configured Identity API is a trusted issuer for this app (C11).
 *
 * It is not in `TRUSTED_UPSTREAMS` because it is not compiled in: it is
 * whatever the Settings store points at, and it is the one runtime issuer this
 * app already trusts with everything else — sessions, principals, org joins.
 * Brokered sign-in (D7/D8) is that same relationship, so its assertions are
 * admitted here and nowhere else. This is deliberately NOT the `orgSlug`
 * allowlist skip in `readIdentity`, which admits any runtime-constructed
 * upstream and is left exactly as narrow as it was (T18).
 */
export function isBrokeredIssuer(issuer: string): boolean {
  const base = trimSlashes(remoteIdentityApi());
  // An unconfigured remote Identity API is "" and must not make the
  // device-native Pages origin a trusted brokered issuer.
  return base.length > 0 && trimSlashes(issuer) === base;
}
