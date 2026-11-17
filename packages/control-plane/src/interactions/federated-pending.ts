import {
  createHash,
  createHmac,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";

/**
 * The pending-leg cookie of the hosted federated sign-in (`./federated.ts`):
 * its shape, its name, and the keyed integrity tag that production routes
 * put on it. Kept apart from the leg itself so the cookie's encoding and its
 * MAC are read in one place; `./federated.ts` re-exports the public names.
 */

/**
 * The per-interaction leg state. Travels in an httpOnly cookie scoped to
 * `/interaction/<uid>` rather than server memory, so the leg survives a
 * restart and does not pin a user to one node. Production routes authenticate
 * the cookie with the deployment pepper so its flow kind and identity context
 * cannot be rewritten. The callback also checks the upstream's state. The
 * verifier is single-use and the cookie is deleted on the callback.
 *
 * Everything past `verifier` is v2 (C3) and OPTIONAL by contract: a cookie
 * written by the previous release is in flight in somebody's browser while a
 * new one boots, and a required field would strand them mid-sign-in. Absent
 * `kind` means `"oidc"`, which is exactly what those cookies are.
 */
export type PendingFederatedAuth = {
  issuer: string;
  state: string;
  nonce: string;
  verifier: string;
  /** Which leg completes this: the OIDC one here, or the generic OAuth2 one. */
  kind?: "oidc" | "oauth2";
  /** Registry id, when the leg started from a catalog button. */
  providerId?: string;
  /** `byo_upstreams` id, when the visitor registered their own issuer. */
  byoId?: string;
  /** Organization id, when this is org sign-in — JIT-joined on completion. */
  orgId?: string;
};

const pendingFederatedAuthSchema = z
  .object({
    issuer: z.string(),
    state: z.string(),
    nonce: z.string(),
    verifier: z.string(),
    kind: z.enum(["oidc", "oauth2"]).optional(),
    providerId: z.string().min(1).optional(),
    byoId: z.string().min(1).optional(),
    orgId: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (pending) => {
      const sources = [
        pending.providerId,
        pending.byoId,
        pending.orgId,
      ].filter((value) => value !== undefined).length;
      if (pending.kind === undefined) return sources === 0;
      if (pending.kind === "oauth2") {
        return pending.providerId !== undefined && sources === 1;
      }
      return sources <= 1;
    },
    { message: "pending state has conflicting provenance" },
  );

/** Cookie carrying `PendingFederatedAuth`, scoped to this interaction only. */
export function pendingCookieName(uid: string): string {
  return `os.fed.${uid}`;
}

/** PKCE verifier binding via scrypt before the pending cookie MAC (not SHA-256 of raw verifier). */
function pendingVerifierBinding(
  verifier: string,
  state: string,
  nonce: string,
  secret: string,
): string {
  const salt = createHash("sha256")
    .update(secret)
    .update("\0opensesame:fed-pending-verifier\0")
    .update(state)
    .update(nonce)
    .digest()
    .subarray(0, 16);
  return scryptSync(verifier, salt, 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  }).toString("base64url");
}

/** Canonical HMAC input: the complete record with scrypt-bound PKCE verifier. */
function pendingIntegrityPayload(
  pending: PendingFederatedAuth,
  verifierBound: string,
): string {
  return JSON.stringify([
    pending.issuer,
    pending.state,
    pending.nonce,
    verifierBound,
    pending.kind ?? null,
    pending.providerId ?? null,
    pending.byoId ?? null,
    pending.orgId ?? null,
  ]);
}

/**
 * Previous-release MAC input, accepted only when no tenant authority rides in
 * it.
 */
function legacyPendingIntegrityPayload(
  pending: PendingFederatedAuth,
  verifierBound: string,
): string {
  return [
    pending.issuer,
    pending.state,
    pending.nonce,
    verifierBound,
    pending.kind ?? "oidc",
    pending.providerId ?? "",
  ].join("\x1f");
}

/** HMAC cookie integrity tag, not a password hash; tests may omit the pepper. */
function pendingSignature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function encodePending(
  pending: PendingFederatedAuth,
  secret?: string,
): string {
  const payload = Buffer.from(JSON.stringify(pending), "utf8").toString(
    "base64url",
  );
  if (!secret) return payload;
  const verifierBound = pendingVerifierBinding(
    pending.verifier,
    pending.state,
    pending.nonce,
    secret,
  );
  const signature = pendingSignature(
    pendingIntegrityPayload(pending, verifierBound),
    secret,
  );
  return `${payload}.${signature}`;
}

/**
 * The signed half of `decodePending`: split the cookie at its last dot, then
 * check the supplied tag against the MAC of the payload's own leg fields.
 * Returns the payload half only once that tag verifies.
 */
function verifiedPendingPayload(
  raw: string,
  secret: string,
): string | undefined {
  const split = raw.lastIndexOf(".");
  if (split <= 0) return undefined;
  const payload = raw.slice(0, split);
  const supplied = Buffer.from(raw.slice(split + 1), "base64url");
  let macPending: PendingFederatedAuth;
  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    const macResult = pendingFederatedAuthSchema.safeParse(parsed);
    if (!macResult.success) return undefined;
    macPending = macResult.data;
  } catch {
    return undefined;
  }
  const verifierBound = pendingVerifierBinding(
    macPending.verifier,
    macPending.state,
    macPending.nonce,
    secret,
  );
  const matches = (integrityPayload: string): boolean => {
    const expected = Buffer.from(
      pendingSignature(integrityPayload, secret),
      "base64url",
    );
    return (
      supplied.length === expected.length && timingSafeEqual(supplied, expected)
    );
  };
  if (matches(pendingIntegrityPayload(macPending, verifierBound))) {
    return payload;
  }
  // Rolling deploy compatibility is safe for v1/static cookies because their
  // old MAC covered every authority-bearing field they carry. Old BYO and org
  // cookies must restart: accepting their legacy MAC would preserve the
  // tenant-substitution vulnerability this verifier is the boundary for.
  if (
    macPending.byoId === undefined &&
    macPending.orgId === undefined &&
    matches(legacyPendingIntegrityPayload(macPending, verifierBound))
  ) {
    return payload;
  }
  return undefined;
}

export function decodePending(
  raw: string | undefined,
  secret?: string,
): PendingFederatedAuth | undefined {
  if (!raw) return undefined;
  let payload = raw;
  if (secret) {
    const verified = verifiedPendingPayload(raw, secret);
    if (verified === undefined) return undefined;
    payload = verified;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    const result = pendingFederatedAuthSchema.safeParse(parsed);
    if (!result.success) return undefined;
    // Rebuilt field by field rather than handed back whole: an absent v2 field
    // must stay absent, not become a present `undefined`. The difference is
    // visible — `{...pending, kind: undefined}` re-encodes as a cookie
    // claiming a `kind` of `null`, which then fails to parse on the way back.
    const data = result.data;
    return {
      issuer: data.issuer,
      state: data.state,
      nonce: data.nonce,
      verifier: data.verifier,
      ...(data.kind !== undefined ? { kind: data.kind } : undefined),
      ...(data.providerId !== undefined
        ? { providerId: data.providerId }
        : undefined),
      ...(data.byoId !== undefined ? { byoId: data.byoId } : undefined),
      ...(data.orgId !== undefined ? { orgId: data.orgId } : undefined),
    };
  } catch {
    return undefined;
  }
}
