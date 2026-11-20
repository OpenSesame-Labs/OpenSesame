import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
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
 * Everything past `verifier` is optional by contract. Absent `kind` means
 * `"oidc"`. Legacy signatures can continue only when the payload contains
 * no fields outside the former signed field set; other cookies must restart.
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

const pendingFederatedAuthSchema = z.object({
  issuer: z.string(),
  state: z.string(),
  nonce: z.string(),
  verifier: z.string(),
  kind: z.enum(["oidc", "oauth2"]).optional(),
  providerId: z.string().optional(),
  byoId: z.string().optional(),
  orgId: z.string().optional(),
});

const wirePendingSchema = pendingFederatedAuthSchema
  .omit({ verifier: true })
  .extend({
    verifier: z.string().optional(),
    verifierEnc: z.string().optional(),
  })
  .strict()
  .refine(
    (data) => data.verifier !== undefined || data.verifierEnc !== undefined,
    {
      message: "verifier field required",
    },
  );

/** Strict wire JSON at the cookie decode boundary; rejects unknown fields via schema. */
function decodeWirePendingJson(
  jsonUtf8: string,
): z.infer<typeof wirePendingSchema> | undefined {
  let wireJson: unknown;
  try {
    wireJson = JSON.parse(jsonUtf8);
  } catch {
    return undefined;
  }
  const parsed = wirePendingSchema.safeParse(wireJson);
  return parsed.success ? parsed.data : undefined;
}

const SCRYPT_PARAMS = {
  N: 32768,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
} as const;

/** Unambiguous (state, nonce) binding so concatenation cannot collide across legs. */
function legBindingMaterial(state: string, nonce: string): Buffer {
  const stateBytes = Buffer.from(state, "utf8");
  const nonceBytes = Buffer.from(nonce, "utf8");
  if (stateBytes.length > 255 || nonceBytes.length > 255) {
    throw new Error(
      "federated pending leg binding exceeds 255-byte field limit",
    );
  }
  return Buffer.concat([
    Buffer.from([stateBytes.length]),
    stateBytes,
    Buffer.from([nonceBytes.length]),
    nonceBytes,
  ]);
}

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
  return scryptSync(verifier, salt, 32, SCRYPT_PARAMS).toString("base64url");
}

function verifierSealKey(secret: string, state: string, nonce: string): Buffer {
  const salt = createHash("sha256")
    .update(secret)
    .update("\0opensesame:fed-pending-verifier-seal\0")
    .update(legBindingMaterial(state, nonce))
    .digest()
    .subarray(0, 16);
  return Buffer.from(
    hkdfSync(
      "sha256",
      secret,
      salt,
      "OpenSesame:federated-pending:verifier-seal",
      32,
    ),
  );
}

/** Seal the PKCE verifier for wire transport; the MAC never covers the raw verifier. */
function sealVerifier(
  verifier: string,
  secret: string,
  state: string,
  nonce: string,
): string {
  const key = verifierSealKey(secret, state, nonce);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(verifier, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
    "base64url",
  );
}

function unsealVerifier(
  sealed: string,
  secret: string,
  state: string,
  nonce: string,
): string | undefined {
  try {
    const raw = Buffer.from(sealed, "base64url");
    if (raw.length < 28) return undefined;
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    if (tag.length !== 16) return undefined;
    const ciphertext = raw.subarray(28);
    const key = verifierSealKey(secret, state, nonce);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return undefined;
  }
}

function wirePendingBody(
  pending: PendingFederatedAuth,
  secret: string,
): z.infer<typeof wirePendingSchema> {
  const { verifier, ...rest } = pending;
  return {
    ...rest,
    verifierEnc: sealVerifier(verifier, secret, pending.state, pending.nonce),
  };
}

function resolveVerifier(
  data: z.infer<typeof wirePendingSchema>,
  secret?: string,
): string | undefined {
  const hasPlain = data.verifier !== undefined;
  const hasSealed = data.verifierEnc !== undefined;
  if (hasPlain && hasSealed) return undefined;
  if (hasSealed) {
    if (secret === undefined || data.verifierEnc === undefined)
      return undefined;
    return unsealVerifier(data.verifierEnc, secret, data.state, data.nonce);
  }
  if (hasPlain) return data.verifier;
  return undefined;
}

function pendingFromWire(
  data: z.infer<typeof wirePendingSchema>,
  verifier: string,
): PendingFederatedAuth {
  return {
    issuer: data.issuer,
    state: data.state,
    nonce: data.nonce,
    verifier,
    ...(data.kind !== undefined ? { kind: data.kind } : undefined),
    ...(data.providerId !== undefined
      ? { providerId: data.providerId }
      : undefined),
    ...(data.byoId !== undefined ? { byoId: data.byoId } : undefined),
    ...(data.orgId !== undefined ? { orgId: data.orgId } : undefined),
  };
}

/** Canonical HMAC input: OAuth leg fields with scrypt-bound PKCE verifier. */
function pendingIntegrityPayload(
  pending: Pick<
    PendingFederatedAuth,
    "issuer" | "state" | "nonce" | "verifier" | "kind" | "providerId"
  >,
  secret: string,
): string {
  const kind = pending.kind ?? "oidc";
  const providerId = pending.providerId ?? "";
  const verifierBound = pendingVerifierBinding(
    pending.verifier,
    pending.state,
    pending.nonce,
    secret,
  );
  return [
    pending.issuer,
    pending.state,
    pending.nonce,
    verifierBound,
    kind,
    providerId,
  ].join("\x1f");
}

/** HMAC cookie integrity tag, not a password hash; tests may omit the pepper. */
function pendingSignature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/**
 * MAC input for v3 cookies: wire fields with scrypt `verifierBound` instead of
 * a plaintext PKCE verifier (CodeQL js/insufficient-password-hash). The cookie
 * still carries `verifierEnc` or rollout plaintext on the wire separately.
 */
function wireMacMaterial(
  data: z.infer<typeof wirePendingSchema>,
  verifier: string,
  secret: string,
): string {
  const { verifier: _plain, ...rest } = data;
  const verifierBound = pendingVerifierBinding(
    verifier,
    data.state,
    data.nonce,
    secret,
  );
  return JSON.stringify({ ...rest, verifierBound });
}

/** Legacy v3 MAC bound the base64 payload (often plaintext verifier). */
function authenticatedPayloadLegacy(
  base64Payload: string,
  legacyInput: string,
): string {
  return `OpenSesame:federated-pending:v3\0${base64Payload}\0${legacyInput}`;
}

function authenticatedPayloadV3(wireMac: string): string {
  return `OpenSesame:federated-pending:v3:wire\0${wireMac}`;
}

/** Dual-field v3 MAC kept for verify-only migration from in-flight cookies. */
function authenticatedPayloadV3Dual(
  wireMac: string,
  legacyInput: string,
): string {
  return `OpenSesame:federated-pending:v3:wire\0${wireMac}\0${legacyInput}`;
}

function modernPendingSignature(wireMac: string, secret: string): string {
  // A distinct key prevents an old-format field from imitating a v3 message.
  const key = createHmac("sha256", secret)
    .update("OpenSesame:federated-pending:v3:key")
    .digest();
  return createHmac("sha256", key)
    .update(authenticatedPayloadV3(wireMac))
    .digest("base64url");
}

function modernPendingSignatureDual(
  wireMac: string,
  legacyInput: string,
  secret: string,
): string {
  const key = createHmac("sha256", secret)
    .update("OpenSesame:federated-pending:v3:key")
    .digest();
  return createHmac("sha256", key)
    .update(authenticatedPayloadV3Dual(wireMac, legacyInput))
    .digest("base64url");
}

function modernPendingSignatureLegacy(
  base64Payload: string,
  legacyInput: string,
  secret: string,
): string {
  const key = createHmac("sha256", secret)
    .update("OpenSesame:federated-pending:v3:key")
    .digest();
  return createHmac("sha256", key)
    .update(authenticatedPayloadLegacy(base64Payload, legacyInput))
    .digest("base64url");
}

function signatureMatches(supplied: Buffer, expected: string): boolean {
  const bytes = Buffer.from(expected, "base64url");
  return supplied.length === bytes.length && timingSafeEqual(supplied, bytes);
}

/**
 * A present pepper always seals the PKCE verifier as `verifierEnc`.
 * `sealVerifierOnWire: false` is the explicit rollout-off shape used by tests
 * and by `OPENSESAME_FEDERATED_PENDING_SEAL_VERIFIER=false`.
 */
export type FederatedPendingEncodeOptions = {
  sealVerifierOnWire?: boolean;
};

export function encodePending(
  pending: PendingFederatedAuth,
  secret?: string,
  options?: FederatedPendingEncodeOptions,
): string {
  // Omit or true seals. Only an explicit false writes a plaintext verifier.
  const sealVerifierOnWire = options?.sealVerifierOnWire !== false;
  const body =
    secret && sealVerifierOnWire ? wirePendingBody(pending, secret) : pending;
  const payload = Buffer.from(JSON.stringify(body), "utf8").toString(
    "base64url",
  );
  if (!secret) return payload;
  const wireForMac = wireMacMaterial(
    wirePendingSchema.parse({
      ...body,
      verifier: pending.verifier,
    }),
    pending.verifier,
    secret,
  );
  return `${payload}.${modernPendingSignature(wireForMac, secret)}`;
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
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) return undefined;
  const supplied = Buffer.from(raw.slice(split + 1), "base64url");
  let macPending: Pick<
    PendingFederatedAuth,
    "issuer" | "state" | "nonce" | "verifier" | "kind" | "providerId"
  >;
  let legacyEligible: boolean;
  let data: z.infer<typeof wirePendingSchema>;
  let verifier: string;
  try {
    const wireData = decodeWirePendingJson(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    if (wireData === undefined) return undefined;
    data = wireData;
    const resolved = resolveVerifier(data, secret);
    if (resolved === undefined) return undefined;
    verifier = resolved;
    // Old signatures did not cover any field outside this set. A future
    // decoder must not give an unsigned extension security meaning.
    const legacyFields = new Set([
      "issuer",
      "state",
      "nonce",
      "verifier",
      "kind",
      "providerId",
    ]);
    // An absent/empty provider ID is MAC-equivalent and could have belonged
    // to an organization or BYO flow whose unsigned ID was stripped.
    const legacyProviderPresent =
      data.providerId !== undefined && data.providerId.length > 0;
    legacyEligible =
      legacyProviderPresent &&
      Object.keys(data).every((field) => legacyFields.has(field));
    macPending = {
      issuer: data.issuer,
      state: data.state,
      nonce: data.nonce,
      verifier,
      ...(data.kind !== undefined ? { kind: data.kind } : undefined),
      ...(data.providerId !== undefined
        ? { providerId: data.providerId }
        : undefined),
    };
  } catch {
    return undefined;
  }
  const legacyInput = pendingIntegrityPayload(macPending, secret);
  const wireForMac = wireMacMaterial(data, verifier, secret);
  const expected = modernPendingSignature(wireForMac, secret);
  const expectedDual = modernPendingSignatureDual(
    wireForMac,
    legacyInput,
    secret,
  );
  const expectedLegacy = modernPendingSignatureLegacy(
    payload,
    legacyInput,
    secret,
  );
  if (signatureMatches(supplied, expected)) return payload;
  if (signatureMatches(supplied, expectedDual)) return payload;
  if (signatureMatches(supplied, expectedLegacy)) return payload;
  if (
    legacyEligible &&
    signatureMatches(supplied, pendingSignature(legacyInput, secret))
  )
    return payload;
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
    const data = decodeWirePendingJson(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    if (data === undefined) return undefined;
    const verifier = resolveVerifier(data, secret);
    if (verifier === undefined) return undefined;
    // Rebuilt field by field rather than handed back whole: an absent v2 field
    // must stay absent, not become a present `undefined`. The difference is
    // visible — `{...pending, kind: undefined}` re-encodes as a cookie
    // claiming a `kind` of `null`, which then fails to parse on the way back.
    return pendingFromWire(data, verifier);
  } catch {
    return undefined;
  }
}
