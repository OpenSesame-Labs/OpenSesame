import { randomUUID } from "node:crypto";
import { DomainError, ownBytes } from "@opensesame/os-domain";

/**
 * Passkey / WebAuthn seam. Production wires Better Auth + SimpleWebAuthn;
 * tests inject `verifyAssertion`.
 */
export interface PasskeyCredential {
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  principalId: string;
  /** ISO 8601, stamped at registration; absent on records made before it was. */
  createdAt?: string;
  /** Unique to a registration; absent on credentials stored before this field. */
  generation?: string;
}

export interface PasskeyAssertion {
  credentialId: string;
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
  signature: Uint8Array;
  /**
   * Which kind of challenge the caller minted and is willing to spend.
   *
   * Omitted means `"authentication"`, so the plain sign-in path keeps its
   * existing meaning and a caller who does not think about this gets the
   * narrow answer rather than the broad one.
   *
   * It exists because a challenge minted to approve one authorization
   * transaction must not be redeemable as a generic second factor. Both
   * assertions prove the same momentary fact — this person, this
   * authenticator, just now — so nothing in the signature distinguishes them;
   * only the purpose the challenge was issued under does, and a verifier that
   * accepts either lets a page mint an approval ceremony, have the person
   * touch their key for something harmless-looking, and redeem the result as
   * a login.
   */
  expectedPurpose?: "authentication" | "transaction";
}

/**
 * Result of an assertion check. `newCounter` is the authenticator's signature
 * counter from the assertion; the seam persists it so a cloned authenticator
 * replaying an older counter is detected (WebAuthn L2 §7.2 step 21).
 */
export interface PasskeyVerifyResult {
  ok: boolean;
  newCounter?: number;
}

export type PasskeyVerifyFn = (
  assertion: PasskeyAssertion,
  credential: PasskeyCredential,
) => Promise<boolean | PasskeyVerifyResult>;

function isBooleanOutcome(
  value: boolean | PasskeyVerifyResult,
): value is boolean {
  return value === true || value === false;
}

export interface PasskeySeam {
  register(
    principalId: string,
    credential: Omit<PasskeyCredential, "principalId" | "generation">,
  ): Promise<PasskeyCredential>;
  verify(
    assertion: PasskeyAssertion,
  ): Promise<{ ok: true; principalId: string } | { ok: false }>;
  /** The principal's own credentials; never anyone else's. */
  list(principalId: string): Promise<PasskeyCredential[]>;
  /** Remove one of the principal's credentials; false when it is not theirs. */
  remove(principalId: string, credentialId: string): Promise<boolean>;
}

export interface PasskeyCredentialStore {
  get(id: string): Promise<PasskeyCredential | undefined>;
  create(record: PasskeyCredential): Promise<boolean>;
  /** Atomically confirm this registration still exists and advance its counter. */
  advance(
    id: string,
    generation: string | undefined,
    counter: number | undefined,
  ): Promise<boolean>;
  listByPrincipal(principalId: string): Promise<PasskeyCredential[]>;
  /** Atomically remove only a credential belonging to this principal. */
  remove(id: string, principalId: string): Promise<boolean>;
}

function copyCredential(record: PasskeyCredential): PasskeyCredential {
  return { ...record, publicKey: ownBytes(record.publicKey) };
}

export function createMemoryPasskeyCredentialStore(): PasskeyCredentialStore {
  const credentials = new Map<string, PasskeyCredential>();
  return {
    get: async (id) => {
      const record = credentials.get(id);
      return record && copyCredential(record);
    },
    create: async (record) => {
      if (credentials.has(record.credentialId)) return false;
      credentials.set(record.credentialId, copyCredential(record));
      return true;
    },
    advance: async (id, generation, counter) => {
      const current = credentials.get(id);
      if (!current || current.generation !== generation) return false;
      if (counter === undefined) return true;
      if (counter === 0) return current.counter === 0;
      if (counter <= current.counter) return false;
      credentials.set(id, { ...current, counter });
      return true;
    },
    listByPrincipal: async (principalId) =>
      [...credentials.values()]
        .filter((record) => record.principalId === principalId)
        .map(copyCredential),
    remove: async (id, principalId) => {
      if (credentials.get(id)?.principalId !== principalId) return false;
      return credentials.delete(id);
    },
  };
}

export function createPasskeySeam(options?: {
  verifyAssertion?: PasskeyVerifyFn;
  credentialStore?: PasskeyCredentialStore;
}): PasskeySeam {
  const credentials =
    options?.credentialStore ?? createMemoryPasskeyCredentialStore();
  const verifyAssertion: PasskeyVerifyFn =
    options?.verifyAssertion ??
    (async () => {
      throw new Error(
        "Passkey verify not configured — inject verifyAssertion for tests/prod",
      );
    });

  return {
    async register(principalId, credential) {
      const record: PasskeyCredential = {
        ...credential,
        publicKey: ownBytes(credential.publicKey),
        principalId,
        createdAt: credential.createdAt ?? new Date().toISOString(),
        generation: randomUUID(),
      };
      if (!(await credentials.create(record))) {
        throw new DomainError(
          "CONFLICT",
          "Passkey credential already registered",
        );
      }
      return record;
    },
    async verify(assertion) {
      const credential = await credentials.get(assertion.credentialId);
      if (!credential) return { ok: false };
      const { credentialId, generation, principalId } = credential;
      const outcome = await verifyAssertion(assertion, credential);
      const result: PasskeyVerifyResult =
        // The verifier contract returns either a boolean or its structured result.
        isBooleanOutcome(outcome) ? { ok: outcome } : outcome;
      if (!result.ok) return { ok: false };

      const next = result.newCounter;
      if (next !== undefined) {
        if (!Number.isSafeInteger(next) || next < 0) return { ok: false };
      }
      // Verification awaited: atomically reject removal, re-registration, and
      // counters already spent while the verifier was running.
      if (!(await credentials.advance(credentialId, generation, next)))
        return { ok: false };
      return { ok: true, principalId };
    },
    list: (principalId) => credentials.listByPrincipal(principalId),
    remove: (principalId, credentialId) =>
      credentials.remove(credentialId, principalId),
  };
}
