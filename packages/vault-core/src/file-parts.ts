/**
 * Encrypted file parts (ADR 0054's chunk size, without convergent encryption).
 *
 * The manifest is text, so it can be the native secret of a vault item. The
 * part key lives in that manifest. Ciphertext lives in an object store. Each
 * part is written to every store in the list; a read uses the first store
 * that still has it.
 *
 * A manifest written now records `partBytes`, the plaintext part size its
 * sealer used, and every part is held to it (at most 1 MiB, 1 MiB + 16 bytes
 * encrypted). A v1 manifest without `partBytes` predates those bounds: only
 * when reading one is an encrypted part accepted up to the drive daemon's
 * former limit of 1 MiB + 1,024 bytes, so existing attachments stay readable.
 * Nothing seals a part that large.
 */

import {
  type JsonValue,
  isJsonObject,
  isNumber,
  overlapCast,
  readString,
} from "@opensesame/os-domain";
import { b64ToBytes, bytesToB64 } from "./bytes.js";
import { importVaultKey, randomBytes } from "./crypto.js";
import { gcmOpen, gcmSeal } from "./gcm.js";

export const FILE_PART_BYTES = 1_048_576;
export const MAX_FILE_BYTES = 1_073_741_824;
export const MAX_FILE_PARTS = 4_096;
export const MAX_FILE_MANIFEST_CHARS = 1_048_576;
/** The GCM authentication tag adds 16 bytes to each encrypted part. */
export const MAX_ENCRYPTED_FILE_PART_BYTES = FILE_PART_BYTES + 16;
/** Read-only allowance for parts named by a legacy (unmarked) v1 manifest. */
export const MAX_LEGACY_ENCRYPTED_FILE_PART_BYTES = FILE_PART_BYTES + 1024;
const LEGACY_PART_BYTES = MAX_LEGACY_ENCRYPTED_FILE_PART_BYTES - 16;

export type ObjectStore = {
  putObject(key: string, body: Uint8Array): Promise<void>;
  getObject(key: string): Promise<Uint8Array | null>;
};

export type MemoryStore = ObjectStore & {
  deleteObject(key: string): Promise<void>;
  listObjects(): Promise<readonly string[]>;
};

export type FilePartRef = {
  readonly key: string;
  readonly nonce: string;
};

export type FileManifest = {
  readonly v: 1;
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  readonly key: string;
  /** Plaintext bytes per part; absent only on a legacy v1 manifest. */
  readonly partBytes?: number;
  readonly parts: readonly FilePartRef[];
};

export type SealedFile = {
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
};

const MISSING = "file part is missing";

export function memoryObjectStore(): MemoryStore {
  const objects = new Map<string, Uint8Array>();
  return {
    async putObject(key, body) {
      objects.set(key, body.slice());
    },
    async getObject(key) {
      const found = objects.get(key);
      return found === undefined ? null : found.slice();
    },
    async deleteObject(key) {
      objects.delete(key);
    },
    async listObjects() {
      return [...objects.keys()];
    },
  };
}

function wholeSize(value: JsonValue | undefined): number | undefined {
  return isNumber(value) && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function manifestParts(value: JsonValue): JsonValue[] | undefined {
  if (!isJsonObject(value) || value.v !== 1 || !Array.isArray(value.parts)) {
    return undefined;
  }
  return value.parts.length <= MAX_FILE_PARTS ? value.parts : undefined;
}

function validPartLayout(
  size: number | undefined,
  partLength: number,
  partBytes: number,
): size is number {
  return (
    size !== undefined &&
    size <= MAX_FILE_BYTES &&
    (size === 0) === (partLength === 0) &&
    !(size > 0 && partLength > size) &&
    partLength >= Math.ceil(size / partBytes)
  );
}

function manifestHeader(
  parsed: { [key: string]: JsonValue | undefined },
  partLength: number,
): Omit<FileManifest, "parts"> | undefined {
  const size = wholeSize(parsed.size);
  const declared = wholeSize(parsed.partBytes);
  if (
    parsed.partBytes !== undefined &&
    (declared === undefined || declared < 1 || declared > FILE_PART_BYTES)
  )
    return undefined;
  const partBytes = declared ?? LEGACY_PART_BYTES;
  if (!validPartLayout(size, partLength, partBytes)) return undefined;
  const name = readString(parsed.name);
  const mediaType = readString(parsed.mediaType);
  const key = readString(parsed.key);
  if (
    name === undefined ||
    mediaType === undefined ||
    key === undefined ||
    name.length > 255 ||
    mediaType.length > 255 ||
    !/^[A-Za-z0-9+/]{43}=$/u.test(key)
  )
    return undefined;
  return {
    v: 1,
    name,
    mediaType,
    size,
    key,
    ...(declared === undefined ? undefined : { partBytes: declared }),
  };
}

function filePartRef(value: JsonValue): FilePartRef | undefined {
  if (!isJsonObject(value)) return undefined;
  const key = readString(value.key);
  const nonce = readString(value.nonce);
  if (
    key === undefined ||
    nonce === undefined ||
    !/^[A-Za-z0-9_-]{16}$/u.test(key) ||
    !/^[A-Za-z0-9+/]{16}$/u.test(nonce)
  ) {
    return undefined;
  }
  return { key, nonce };
}

export function readFileManifest(text: string): FileManifest | undefined {
  if (text.length > MAX_FILE_MANIFEST_CHARS) return undefined;
  let parsed: JsonValue;
  try {
    parsed = overlapCast(JSON.parse(text));
  } catch {
    return undefined;
  }
  const rawParts = manifestParts(parsed);
  if (!rawParts || !isJsonObject(parsed)) return undefined;
  const header = manifestHeader(parsed, rawParts.length);
  if (!header) return undefined;
  const parts: FilePartRef[] = [];
  for (const value of rawParts) {
    const part = filePartRef(value);
    if (!part) return undefined;
    parts.push(part);
  }
  return { ...header, parts };
}

/** Filename, media type and size. The part key stays inside the manifest. */
export function fileSummary(
  text: string,
): { name: string; mediaType: string; size: number } | null {
  const manifest = readFileManifest(text);
  if (manifest === undefined) return null;
  return {
    name: manifest.name,
    mediaType: manifest.mediaType,
    size: manifest.size,
  };
}

function objectKey(iv: Uint8Array): string {
  return bytesToB64(iv).replaceAll("+", "-").replaceAll("/", "_");
}

async function freshKey() {
  const raw = randomBytes(32);
  try {
    return { key: await importVaultKey(raw), encoded: bytesToB64(raw) };
  } finally {
    raw.fill(0);
  }
}

async function keyFromManifest(encoded: string): Promise<CryptoKey> {
  const raw = b64ToBytes(encoded);
  try {
    return await importVaultKey(raw);
  } finally {
    raw.fill(0);
  }
}

async function putReplicas(
  stores: readonly ObjectStore[],
  key: string,
  body: Uint8Array,
): Promise<void> {
  for (const store of stores) await store.putObject(key, body);
}

async function getReplica(
  stores: readonly ObjectStore[],
  key: string,
): Promise<Uint8Array> {
  for (const store of stores) {
    const found = await store.getObject(key);
    if (found !== null) return found;
  }
  throw new Error(MISSING);
}

async function sealOne(
  key: CryptoKey,
  bytes: Uint8Array,
  index: number,
  count: number,
  partBytes: number,
) {
  const start = index * partBytes;
  const plain = bytes.subarray(
    start,
    Math.min(start + partBytes, bytes.byteLength),
  );
  const iv = randomBytes(12);
  const body = await gcmSeal(
    key,
    plain,
    iv,
    new TextEncoder().encode(`${index}:${count}`),
  );
  return {
    ref: { key: objectKey(iv), nonce: bytesToB64(iv) },
    body,
  };
}

function partCount(length: number, partBytes: number): number {
  if (length === 0) return 0;
  return Math.ceil(length / partBytes);
}

export async function sealFile(input: {
  name: string;
  mediaType: string;
  bytes: Uint8Array;
  stores: readonly ObjectStore[];
  partBytes?: number;
  maxBytes?: number;
}): Promise<string> {
  if (input.stores.length === 0) throw new Error("file needs a store");
  const partBytes = input.partBytes ?? FILE_PART_BYTES;
  const maxBytes = input.maxBytes ?? MAX_FILE_BYTES;
  if (
    !Number.isSafeInteger(partBytes) ||
    partBytes < 1 ||
    partBytes > FILE_PART_BYTES
  )
    throw new Error("invalid file part size");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new Error("invalid file size limit");
  if (input.bytes.byteLength > Math.min(maxBytes, MAX_FILE_BYTES))
    throw new Error("file exceeds the size limit");
  const count = partCount(input.bytes.byteLength, partBytes);
  if (count > MAX_FILE_PARTS)
    throw new Error("file exceeds the part count limit");
  const { key, encoded } = await freshKey();
  const parts: FilePartRef[] = [];
  for (let index = 0; index < count; index += 1) {
    const sealed = await sealOne(key, input.bytes, index, count, partBytes);
    await putReplicas(input.stores, sealed.ref.key, sealed.body);
    parts.push(sealed.ref);
  }
  return JSON.stringify({
    v: 1,
    name: input.name,
    mediaType: input.mediaType,
    size: input.bytes.byteLength,
    key: encoded,
    partBytes,
    parts,
  });
}

/** The largest plaintext part this manifest may name. */
function partLimit(manifest: FileManifest): number {
  return manifest.partBytes ?? LEGACY_PART_BYTES;
}

async function openOne(
  key: CryptoKey,
  ref: FilePartRef,
  index: number,
  count: number,
  stores: readonly ObjectStore[],
  limit: number,
): Promise<Uint8Array> {
  const body = await getReplica(stores, ref.key);
  if (body.byteLength > limit + 16) throw new Error(MISSING);
  try {
    return await gcmOpen(
      key,
      b64ToBytes(ref.nonce),
      body,
      new TextEncoder().encode(`${index}:${count}`),
    );
  } catch (error) {
    if (error instanceof Error) throw new Error(MISSING);
    throw error;
  }
}

export async function openFile(
  manifestText: string,
  stores: readonly ObjectStore[],
): Promise<SealedFile> {
  const manifest = readFileManifest(manifestText);
  if (manifest === undefined) throw new Error(MISSING);
  const key = await keyFromManifest(manifest.key);
  const count = manifest.parts.length;
  const limit = partLimit(manifest);
  const bytes = new Uint8Array(manifest.size);
  let offset = 0;
  try {
    for (let index = 0; index < count; index += 1) {
      const ref = manifest.parts[index];
      if (ref === undefined) throw new Error(MISSING);
      const opened = await openOne(key, ref, index, count, stores, limit);
      try {
        if (
          opened.byteLength === 0 ||
          opened.byteLength > limit ||
          opened.byteLength > bytes.byteLength - offset
        )
          throw new Error(MISSING);
        bytes.set(opened, offset);
        offset += opened.byteLength;
      } finally {
        opened.fill(0);
      }
    }
    if (offset !== bytes.byteLength) throw new Error(MISSING);
  } catch (error) {
    bytes.fill(0);
    throw error;
  }
  return {
    name: manifest.name,
    mediaType: manifest.mediaType,
    bytes,
  };
}
