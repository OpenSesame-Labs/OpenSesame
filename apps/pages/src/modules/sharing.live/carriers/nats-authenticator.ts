/** NATS JWT challenge signing without the Node-oriented nkeys/tweetnacl graph. */

import type { Authenticator } from "@nats-io/nats-core";
import { ed25519 } from "@noble/curves/ed25519.js";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const text = new TextEncoder();

function crc16(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1)
      crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff;
  }
  return crc;
}

function base32Decode(value: string): Uint8Array {
  let bits = 0;
  let carry = 0;
  const out: number[] = [];
  for (const character of value) {
    const digit = BASE32.indexOf(character);
    if (digit < 0) throw new Error("Invalid NATS seed encoding");
    carry = (carry << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      out.push((carry >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let carry = 0;
  let out = "";
  for (const byte of bytes) {
    carry = (carry << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(carry >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(carry << (5 - bits)) & 31];
  return out;
}

function decodeSeed(encoded: string): { role: number; seed: Uint8Array } {
  const raw = base32Decode(encoded.trim());
  if (raw.length !== 36) throw new Error("Invalid NATS seed length");
  const payload = raw.subarray(0, raw.length - 2);
  const expected = raw[raw.length - 2] | (raw[raw.length - 1] << 8);
  if (crc16(payload) !== expected)
    throw new Error("Invalid NATS seed checksum");
  if ((raw[0] & 0xf8) !== 0x90) throw new Error("Invalid NATS seed prefix");
  const role = ((raw[0] & 7) << 5) | ((raw[1] & 0xf8) >>> 3);
  return { role, seed: raw.slice(2, 34) };
}

function publicNkey(role: number, publicKey: Uint8Array): string {
  const payload = new Uint8Array(35);
  payload[0] = role;
  payload.set(publicKey, 1);
  const checksum = crc16(payload.subarray(0, 33));
  payload[33] = checksum & 0xff;
  payload[34] = checksum >>> 8;
  return base32Encode(payload);
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Exact synchronous Authenticator contract consumed by the official core. */
export function browserJwtAuthenticator(
  jwt: string,
  encodedSeed: string,
): Authenticator {
  const { role, seed } = decodeSeed(encodedSeed);
  const nkey = publicNkey(role, ed25519.getPublicKey(seed));
  return (nonce) => ({
    jwt,
    nkey,
    sig: nonce ? base64(ed25519.sign(text.encode(nonce), seed)) : "",
  });
}
