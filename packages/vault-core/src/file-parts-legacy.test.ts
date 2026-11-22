/**
 * Legacy v1 file compatibility: a manifest without `partBytes` predates the
 * part bounds, and only then is a part up to the drive daemon's former limit
 * (1 MiB + 1,024 bytes encrypted) accepted. Everything sealed now is marked
 * and held to 1 MiB + 16 bytes.
 */
import { describe, expect, it } from "vitest";
import { bytesToB64 } from "./bytes.js";
import { importVaultKey } from "./crypto.js";
import {
  FILE_PART_BYTES,
  MAX_ENCRYPTED_FILE_PART_BYTES,
  MAX_LEGACY_ENCRYPTED_FILE_PART_BYTES,
  memoryObjectStore,
  openFile,
  readFileManifest,
  sealFile,
} from "./file-parts.js";
import { gcmSeal } from "./gcm.js";

const LEGACY_PART_BYTES = MAX_LEGACY_ENCRYPTED_FILE_PART_BYTES - 16;

/** What a pre-bounds sealer wrote: unmarked v1, wider parts. */
async function sealLegacyFile(
  bytes: Uint8Array,
  partBytes: number,
  extra: Record<string, unknown> = {},
) {
  const store = memoryObjectStore();
  const raw = new Uint8Array(32).fill(7);
  const key = await importVaultKey(raw);
  const count = Math.ceil(bytes.byteLength / partBytes);
  const parts = [];
  for (let index = 0; index < count; index += 1) {
    const iv = new Uint8Array(12);
    iv[11] = index + 1;
    const nonce = bytesToB64(iv);
    const objectKey = nonce.replaceAll("+", "-").replaceAll("/", "_");
    const body = await gcmSeal(
      key,
      bytes.subarray(index * partBytes, (index + 1) * partBytes),
      iv,
      new TextEncoder().encode(`${index}:${count}`),
    );
    await store.putObject(objectKey, body);
    parts.push({ key: objectKey, nonce });
  }
  const manifest = {
    v: 1,
    name: "legacy.bin",
    mediaType: "application/octet-stream",
    size: bytes.byteLength,
    key: bytesToB64(raw),
    parts,
    ...extra,
  };
  return { store, text: JSON.stringify(manifest) };
}

function patterned(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 4093) bytes[index] = index % 251;
  bytes[size - 1] = 9;
  return bytes;
}

describe("legacy v1 file parts", () => {
  it("opens an unmarked v1 file whose parts reach the daemon's former limit", async () => {
    for (const size of [LEGACY_PART_BYTES, LEGACY_PART_BYTES + 13]) {
      const bytes = patterned(size);
      const { store, text } = await sealLegacyFile(bytes, LEGACY_PART_BYTES);
      const manifest = readFileManifest(text);
      expect(manifest?.partBytes).toBeUndefined();
      const first = await store.getObject(manifest?.parts[0]?.key ?? "");
      expect(first?.byteLength).toBe(MAX_LEGACY_ENCRYPTED_FILE_PART_BYTES);
      const opened = await openFile(text, [store]);
      expect(opened.bytes).toEqual(bytes);
    }
  });

  it("refuses a legacy part beyond the former limit", async () => {
    const bytes = patterned(LEGACY_PART_BYTES + 1);
    const { store, text } = await sealLegacyFile(bytes, LEGACY_PART_BYTES + 1);
    await expect(openFile(text, [store])).rejects.toThrow(
      "file part is missing",
    );
  });

  it("holds a marked manifest to its own part size, even with legacy-sized parts", async () => {
    // Same ciphertext as a legacy file, but the manifest claims the bounded
    // format: the wider parts are refused, not tolerated.
    const bytes = patterned(LEGACY_PART_BYTES + 13);
    const { store, text } = await sealLegacyFile(bytes, LEGACY_PART_BYTES, {
      partBytes: FILE_PART_BYTES,
    });
    expect(readFileManifest(text)?.partBytes).toBe(FILE_PART_BYTES);
    await expect(openFile(text, [store])).rejects.toThrow(
      "file part is missing",
    );
    // One legacy-sized part cannot cover the size a 1 MiB part bound allows.
    const single = await sealLegacyFile(
      patterned(LEGACY_PART_BYTES),
      LEGACY_PART_BYTES,
      { partBytes: FILE_PART_BYTES },
    );
    expect(readFileManifest(single.text)).toBeUndefined();
  });

  it("refuses a malformed part-size marker", async () => {
    for (const partBytes of [0, -1, 1.5, FILE_PART_BYTES + 1, "1048576"]) {
      const { text } = await sealLegacyFile(new Uint8Array([1]), 1, {
        partBytes,
      });
      expect(readFileManifest(text), String(partBytes)).toBeUndefined();
    }
  });

  it("keeps main's other strict limits for legacy manifests", async () => {
    const { text } = await sealLegacyFile(new Uint8Array([1]), 1, {
      name: "n".repeat(256),
    });
    expect(readFileManifest(text)).toBeUndefined();
  });

  it("never writes a legacy part: new files are marked and strictly sized", async () => {
    const store = memoryObjectStore();
    await expect(
      sealFile({
        name: "wide.bin",
        mediaType: "application/octet-stream",
        bytes: new Uint8Array(LEGACY_PART_BYTES),
        stores: [store],
        partBytes: LEGACY_PART_BYTES,
      }),
    ).rejects.toThrow("invalid file part size");
    expect(await store.listObjects()).toEqual([]);

    const bytes = patterned(FILE_PART_BYTES + 1009);
    const text = await sealFile({
      name: "new.bin",
      mediaType: "application/octet-stream",
      bytes,
      stores: [store],
    });
    const manifest = readFileManifest(text);
    expect(manifest?.partBytes).toBe(FILE_PART_BYTES);
    expect(manifest?.parts).toHaveLength(2);
    for (const key of await store.listObjects())
      expect((await store.getObject(key))?.byteLength ?? 0).toBeLessThanOrEqual(
        MAX_ENCRYPTED_FILE_PART_BYTES,
      );
    expect((await openFile(text, [store])).bytes).toEqual(bytes);
  });
});
