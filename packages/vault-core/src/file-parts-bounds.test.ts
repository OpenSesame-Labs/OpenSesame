import { describe, expect, it, vi } from "vitest";
import { bytesToB64 } from "./bytes.js";
import { importVaultKey } from "./crypto.js";
import {
  FILE_PART_BYTES,
  MAX_FILE_BYTES,
  MAX_FILE_PARTS,
  MAX_FILE_PART_CIPHERTEXT_BYTES,
  memoryObjectStore,
  openFile,
  readFileManifest,
  sealFile,
} from "./file-parts.js";
import { gcmSeal } from "./gcm.js";

/** The v1 sealer accepted an application-supplied part size before bounds. */
async function sealLegacyFile(bytes: Uint8Array, partBytes: number) {
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
  return {
    store,
    text: JSON.stringify({
      v: 1,
      name: "legacy.bin",
      mediaType: "application/octet-stream",
      size: bytes.byteLength,
      key: bytesToB64(raw),
      parts,
    }),
  };
}

describe("untrusted file manifest bounds", () => {
  it("refuses oversized and impossible manifests before touching a store", async () => {
    const store = memoryObjectStore();
    const text = await sealFile({
      name: "a",
      mediaType: "text/plain",
      bytes: new Uint8Array([1, 2, 3, 4]),
      stores: [store],
    });
    const original = JSON.parse(text);
    const getObject = vi.fn(async () => null);
    for (const value of [
      { ...original, size: MAX_FILE_BYTES + 1 },
      { ...original, size: Number.MAX_SAFE_INTEGER + 1 },
      { ...original, size: MAX_FILE_PART_CIPHERTEXT_BYTES - 16 + 1 },
      { ...original, parts: [] },
      { ...original, parts: Array(MAX_FILE_PARTS + 1).fill(original.parts[0]) },
    ]) {
      const encoded = JSON.stringify(value);
      expect(readFileManifest(encoded)).toBeUndefined();
      await expect(
        openFile(encoded, [{ getObject, putObject: vi.fn() }]),
      ).rejects.toThrow();
    }
    expect(readFileManifest(" ".repeat(2 * 1024 * 1024 + 1))).toBeUndefined();
    expect(getObject).not.toHaveBeenCalled();
  });

  it("refuses oversized ciphertext and an authenticated part exceeding the declared file size", async () => {
    const store = memoryObjectStore();
    const text = await sealFile({
      name: "a",
      mediaType: "text/plain",
      bytes: new Uint8Array([1, 2, 3, 4]),
      stores: [store],
    });
    const oversized = {
      ...store,
      getObject: vi.fn(
        async () => new Uint8Array(MAX_FILE_PART_CIPHERTEXT_BYTES + 1),
      ),
    };
    await expect(openFile(text, [oversized])).rejects.toThrow();
    const smaller = { ...JSON.parse(text), size: 3 };
    await expect(openFile(JSON.stringify(smaller), [store])).rejects.toThrow();
  });

  it("opens a pre-bounds v1 file at the old daemon's exact ciphertext limit", async () => {
    const legacyPartBytes = MAX_FILE_PART_CIPHERTEXT_BYTES - 16;
    for (const size of [legacyPartBytes, legacyPartBytes + 13]) {
      const bytes = new Uint8Array(size);
      bytes[0] = 1;
      bytes[legacyPartBytes - 1] = 2;
      bytes[bytes.length - 1] = 4;
      const { text, store } = await sealLegacyFile(bytes, legacyPartBytes);
      const manifest = readFileManifest(text);
      expect(manifest?.parts).toHaveLength(Math.ceil(size / legacyPartBytes));
      const firstKey = manifest?.parts[0]?.key ?? "";
      expect((await store.getObject(firstKey))?.byteLength).toBe(
        MAX_FILE_PART_CIPHERTEXT_BYTES,
      );
      const opened = await openFile(text, [store]);
      expect(opened.name).toBe("legacy.bin");
      expect(opened.mediaType).toBe("application/octet-stream");
      expect(opened.bytes.length).toBe(bytes.length);
      expect(opened.bytes.every((byte, index) => byte === bytes[index])).toBe(
        true,
      );
    }
  });

  it("refuses excessive part counts before writing and validates the part size", async () => {
    const store = memoryObjectStore();
    const base = {
      name: "a",
      mediaType: "text/plain",
      bytes: new Uint8Array(MAX_FILE_PARTS + 1),
      stores: [store],
    };
    await expect(sealFile({ ...base, partBytes: 1 })).rejects.toThrow(
      "too many parts",
    );
    await expect(sealFile({ ...base, partBytes: Number.NaN })).rejects.toThrow(
      "invalid file part size",
    );
    await expect(
      sealFile({ ...base, partBytes: FILE_PART_BYTES + 1 }),
    ).rejects.toThrow("invalid file part size");
    expect(await store.listObjects()).toEqual([]);
  });
});
