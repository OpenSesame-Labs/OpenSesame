import { host } from "../host.js";
import { maybePage, sessionStore } from "../ports.js";
import { isSealedAtRest } from "./at-rest/cipher.js";
import { IDENTITY_COOKIE_BINDING_KEY as KEY } from "./identity-cookie-binding-key.js";

export type CookieBinding = {
  issuerOrigin: string;
  principalId: string;
  sessionId: string;
  proof: string;
};
let memory: CookieBinding | null = null;

/** Only the hash leaves the tab when a new provisional session is minted. */
export async function newCookieProof(): Promise<{
  proof: string;
  hash: string;
}> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const proof = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(proof)),
  );
  return {
    proof,
    hash: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    ),
  };
}

/** Tab-owned, sealed metadata; this record never contains a bearer. */
export function saveCookieBinding(binding: CookieBinding): boolean {
  memory = binding;
  try {
    const value = JSON.stringify(binding);
    sessionStore().setItem(KEY, value);
    return sessionStore().getItem(KEY) === value;
  } catch {
    // Without durable session storage a redirect must sign in again.
    return false;
  }
}

export function validCookieBinding(
  value: unknown,
  issuerOrigin: string,
): value is CookieBinding {
  if (
    !value ||
    typeof value !== "object" ||
    !("issuerOrigin" in value) ||
    !("principalId" in value) ||
    !("sessionId" in value) ||
    !("proof" in value)
  )
    return false;
  return (
    value.issuerOrigin === issuerOrigin &&
    validId(value.principalId) &&
    validId(value.sessionId) &&
    typeof value.proof === "string" &&
    /^[0-9a-f]{64}$/u.test(value.proof)
  );
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

export function readCookieBinding(issuerOrigin: string): CookieBinding | null {
  if (memory) return memory.issuerOrigin === issuerOrigin ? memory : null;
  try {
    const raw = sessionStore().getItem(KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    return validCookieBinding(value, issuerOrigin) ? value : null;
  } catch {
    return null;
  }
}

/** Distinguish a missing proof from one that storage cannot open or verify. */
export function inspectCookieBinding(
  issuerOrigin: string,
):
  | { kind: "none" }
  | { kind: "unavailable" }
  | { kind: "present"; value: CookieBinding } {
  try {
    const physical = host().storage?.session;
    if (!physical && maybePage()) return { kind: "unavailable" };
    const raw = physical?.getItem(KEY) ?? null;
    if (raw !== null) {
      if (!isSealedAtRest(raw)) return { kind: "unavailable" };
      const opened = sessionStore().getItem(KEY);
      if (!opened) return { kind: "unavailable" };
      const value: unknown = JSON.parse(opened);
      return validCookieBinding(value, issuerOrigin)
        ? { kind: "present", value }
        : { kind: "unavailable" };
    }
    if (!memory) return { kind: "none" };
    return validCookieBinding(memory, issuerOrigin)
      ? { kind: "present", value: memory }
      : { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
}

export function clearCookieBinding(): void {
  memory = null;
  try {
    sessionStore().removeItem(KEY);
  } catch {
    // An unavailable store cannot resume a session.
  }
}

/** Do not clear a newer session if an older probe finishes after sign-out. */
export function clearMatchingCookieBinding(binding: CookieBinding): void {
  const current = readCookieBinding(binding.issuerOrigin);
  if (
    current?.principalId === binding.principalId &&
    current.sessionId === binding.sessionId &&
    current.proof === binding.proof
  )
    clearCookieBinding();
}
