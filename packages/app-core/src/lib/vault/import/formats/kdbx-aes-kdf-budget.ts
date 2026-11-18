/** Screen KDBX 3/4 AES-KDF rounds before kdbxweb builds its work queue. */
import { KdbxImportError } from "./kdbx-argon2.js";

const MAX_HEADER_BYTES = 1024 * 1024;
const MAX_AES_ROUNDS = 1n << 24n;
const decoder = new TextDecoder();

function malformed(): never {
  throw new KdbxImportError(
    "This database could not be read. Its header is invalid or oversized.",
  );
}

function checkRounds(rounds: bigint): void {
  if (rounds > MAX_AES_ROUNDS) {
    throw new KdbxImportError(
      "This database's AES key derivation exceeds the importer's work budget. Open it in KeePassXC and save a copy using at most 16,777,216 AES-KDF rounds before importing.",
    );
  }
}

class Cursor {
  private position = 0;
  private readonly view: DataView;
  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  take(size: number): Uint8Array {
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > this.bytes.length - this.position
    )
      malformed();
    const start = this.position;
    this.position += size;
    return this.bytes.subarray(start, this.position);
  }
  u8(): number {
    const position = this.position;
    this.take(1);
    return this.view.getUint8(position);
  }
  u16(): number {
    const position = this.position;
    this.take(2);
    return this.view.getUint16(position, true);
  }
  u32(): number {
    const position = this.position;
    this.take(4);
    return this.view.getUint32(position, true);
  }
}

function inspectInteger32(type: number, key: string, value: Uint8Array): void {
  if (value.length !== 4) malformed();
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  const number =
    type === 0x04 ? view.getUint32(0, true) : view.getInt32(0, true);
  if (key === "R" && number > 0) checkRounds(BigInt(number));
}

function inspectInteger64(key: string, value: Uint8Array): void {
  if (value.length !== 8) malformed();
  // kdbxweb interprets both dictionary 64-bit types via its unsigned Int64.
  if (key === "R")
    checkRounds(
      new DataView(
        value.buffer,
        value.byteOffset,
        value.byteLength,
      ).getBigUint64(0, true),
    );
}

function inspectValue(type: number, key: string, value: Uint8Array): void {
  switch (type) {
    case 0x04:
    case 0x0c:
      inspectInteger32(type, key, value);
      return;
    case 0x05:
    case 0x0d:
      inspectInteger64(key, value);
      return;
    case 0x08:
      if (value.length !== 1) malformed();
      return;
    case 0x18:
    case 0x42:
      return;
    default:
      malformed();
  }
}

function inspectDictionary(bytes: Uint8Array): void {
  const cursor = new Cursor(bytes);
  cursor.u8(); // minor version
  if (cursor.u8() !== 1) malformed();
  while (true) {
    const type = cursor.u8();
    if (type === 0) return;
    const keyBytes = cursor.take(cursor.u32());
    if (keyBytes.length === 0) malformed();
    const key = decoder.decode(keyBytes);
    const value = cursor.take(cursor.u32());
    inspectValue(type, key, value);
  }
}

/** The magic has already been checked by the importer. */
export function checkAesKdfBudget(bytes: Uint8Array): void {
  const cursor = new Cursor(bytes.subarray(0, MAX_HEADER_BYTES));
  cursor.take(8);
  cursor.u16(); // minor version
  const major = cursor.u16();
  if (major !== 3 && major !== 4) malformed();
  let dictionarySeen = false;
  while (true) {
    const field = cursor.u8();
    const size = major === 3 ? cursor.u16() : cursor.u32();
    const value = cursor.take(size);
    if (field === 0) return;
    if (major === 3 && field === 6) {
      if (value.length < 8) malformed();
      checkRounds(
        new DataView(
          value.buffer,
          value.byteOffset,
          value.byteLength,
        ).getBigUint64(0, true),
      );
    }
    if (major === 4 && field === 11) {
      if (dictionarySeen) malformed();
      dictionarySeen = true;
      inspectDictionary(value);
    }
  }
}
