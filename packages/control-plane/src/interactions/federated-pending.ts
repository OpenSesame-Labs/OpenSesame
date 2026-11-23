import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";

/**
 * The pending-leg cookie of the hosted federated sign-in (`./federated.ts`):
 * its shape, its name, and the keyed integrity tag that production routes
 * put on it. Kept apart from the leg itself so the cookie's encoding and its
 * MAC are read in one place; `./federated.ts` re-exports the public names.
 *
 * Signed format (v4): `<base64url JSON>.<base64url HMAC-SHA-256>`. The JSON
 * carries the PKCE verifier only sealed (`verifierEnc`, AES-256-GCM under a
 * key bound to the leg's state and nonce). The tag covers the exact encoded
 * payload and is checked before the payload is parsed, unsealed or passed to
 * any key derivation, so an unauthenticated cookie costs one HMAC. No slow
 * password hash is involved: the verifier is a random PKCE secret, not a
 * password, and its confidentiality comes from the seal.
 *
 * Earlier signed formats (v3 and the pre-v3 legacy tag) bound a scrypt digest
 * of the verifier, so checking them meant running scrypt on attacker input
 * before authentication. They are refused; a sign-in still holding one (the
 * cookie lives at most `FEDERATED_PENDING_TTL_SECONDS`, ten minutes) restarts.
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
 * `"oidc"`.
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

/** Unsigned (no pepper) wire shape: the plain leg, no unknown fields. */
const unsignedWireSchema = pendingFederatedAuthSchema.strict();

/** Signed wire shape: the verifier only sealed; a plaintext one is refused. */
const sealedWireSchema = pendingFederatedAuthSchema
  .omit({ verifier: true })
  .extend({ verifierEnc: z.string() })
  .strict();

type SealedWire = z.infer<typeof sealedWireSchema>;

/** A browser stores at most ~4 KiB per cookie; anything longer is not ours. */
const MAX_PENDING_COOKIE_LENGTH = 4096;
const MAC_KEY_LABEL = "OpenSesame:federated-pending:v4:key";
const MAC_DOMAIN = "OpenSesame:federated-pending:v4\0";

/**
 * Key derivations the codec performs. A seam, not configuration: tests pass a
 * counting wrapper to show that no derivation runs before the MAC verifies.
 */
export type PendingCookieKeys = {
  /** Per-leg AES-256-GCM key that seals the PKCE verifier. */
  verifierSealKey: (secret: string, state: string, nonce: string) => Buffer;
};

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

const defaultKeys: PendingCookieKeys = { verifierSealKey };

/** Cookie carrying `PendingFederatedAuth`, scoped to this interaction only. */
export function pendingCookieName(uid: string): string {
  return `os.fed.${uid}`;
}

/** Seal the PKCE verifier for wire transport under its leg-bound key. */
function sealVerifier(key: Buffer, verifier: string): string {
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

function unsealVerifier(key: Buffer, sealed: string): string | undefined {
  try {
    const raw = Buffer.from(sealed, "base64url");
    if (raw.length < 28) return undefined;
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([
      decipher.update(raw.subarray(28)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return undefined;
  }
}

/** HMAC-SHA-256 over the exact encoded payload, under a v4-only derived key. */
function pendingMac(payload: string, secret: string): Buffer {
  // A distinct key keeps a v4 tag from verifying any other message format.
  const key = createHmac("sha256", secret).update(MAC_KEY_LABEL).digest();
  return createHmac("sha256", key).update(MAC_DOMAIN).update(payload).digest();
}

function pendingFromWire(
  data: Omit<z.infer<typeof pendingFederatedAuthSchema>, "verifier">,
  verifier: string,
): PendingFederatedAuth {
  // Rebuilt field by field rather than handed back whole: an absent field
  // must stay absent, not become a present `undefined` that re-encodes as
  // `null` and then fails to parse on the way back.
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

function base64urlJson(value: PendingFederatedAuth | SealedWire): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** Parse base64url JSON against `schema`; anything else is `undefined`. */
function parseWire<T>(schema: z.ZodType<T>, payload: string): T | undefined {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

/**
 * With a pepper (every production route), the verifier is sealed and the
 * cookie carries a v4 tag. Without one (unit fixtures only) the leg is plain,
 * unsigned JSON.
 */
export function encodePending(
  pending: PendingFederatedAuth,
  secret?: string,
  keys: PendingCookieKeys = defaultKeys,
): string {
  if (!secret) return base64urlJson(pendingFromWire(pending, pending.verifier));
  const { verifier, ...rest } = pendingFromWire(pending, pending.verifier);
  const key = keys.verifierSealKey(secret, pending.state, pending.nonce);
  const wire: SealedWire = {
    ...rest,
    verifierEnc: sealVerifier(key, verifier),
  };
  const payload = base64urlJson(wire);
  return `${payload}.${pendingMac(payload, secret).toString("base64url")}`;
}

/**
 * The signed half of `decodePending`. Splits the cookie at its last dot and
 * checks the tag over the payload's exact bytes first; only an authenticated
 * payload is parsed, and only then is its verifier unsealed.
 */
function decodeSigned(
  raw: string,
  secret: string,
  keys: PendingCookieKeys,
): PendingFederatedAuth | undefined {
  if (raw.length > MAX_PENDING_COOKIE_LENGTH) return undefined;
  const split = raw.lastIndexOf(".");
  if (split <= 0) return undefined;
  const payload = raw.slice(0, split);
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) return undefined;
  const supplied = Buffer.from(raw.slice(split + 1), "base64url");
  const expected = pendingMac(payload, secret);
  if (supplied.length !== expected.length) return undefined;
  if (!timingSafeEqual(supplied, expected)) return undefined;
  const wire = parseWire(sealedWireSchema, payload);
  if (wire === undefined) return undefined;
  const { verifierEnc, ...rest } = wire;
  let key: Buffer;
  try {
    key = keys.verifierSealKey(secret, rest.state, rest.nonce);
  } catch {
    return undefined;
  }
  const verifier = unsealVerifier(key, verifierEnc);
  if (verifier === undefined) return undefined;
  return pendingFromWire(rest, verifier);
}

export function decodePending(
  raw: string | undefined,
  secret?: string,
  keys: PendingCookieKeys = defaultKeys,
): PendingFederatedAuth | undefined {
  if (!raw) return undefined;
  if (secret) return decodeSigned(raw, secret, keys);
  const leg = parseWire(unsignedWireSchema, raw);
  return leg === undefined ? undefined : pendingFromWire(leg, leg.verifier);
}
