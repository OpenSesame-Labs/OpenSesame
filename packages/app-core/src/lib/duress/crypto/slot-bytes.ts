/**
 * Shared byte encoding and KDF helpers for profile slots and PRF-and-code envelopes.
 */

import { asBufferSource } from "@opensesame/os-domain";
import {
  assertDuressCodeLength,
  assertDuressKdfParams,
} from "../keys/pin-floors.js";

export const te = new TextEncoder();
export const SLOT_PURPOSE = te.encode("opensesame/duress/slot/v1");
export const PRF_CODE_PURPOSE = te.encode("opensesame/duress/prf-and-code/v1");
export const IV_BYTES = 12;
export const SALT_BYTES = 16;

export function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Borrow caller bytes through an owned snapshot that is wiped on settlement. */
export async function withSecretCopy<T>(
  source: Uint8Array,
  use: (copy: Uint8Array<ArrayBuffer>) => Promise<T>,
): Promise<T> {
  const copy = new Uint8Array(source);
  try {
    return await use(copy);
  } finally {
    copy.fill(0);
  }
}

/** Consume a derived key's bytes, including when WebCrypto rejects the import. */
export async function importOwnedAes(raw: Uint8Array): Promise<CryptoKey> {
  try {
    return await withSecretCopy(raw, (copy) =>
      crypto.subtle.importKey("raw", copy, "AES-GCM", false, [
        "encrypt",
        "decrypt",
      ]),
    );
  } finally {
    raw.fill(0);
  }
}

export async function pbkdf2(
  code: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  assertDuressKdfParams({ iterations, saltB64: b64(salt) });
  const password = te.encode(code);
  try {
    const base = await crypto.subtle.importKey(
      "raw",
      password,
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const bits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: asBufferSource(salt),
        iterations,
      },
      base,
      256,
    );
    return new Uint8Array(bits);
  } finally {
    password.fill(0);
  }
}

export function assertTriggerCodeLength(code: string): void {
  assertDuressCodeLength(code);
}
