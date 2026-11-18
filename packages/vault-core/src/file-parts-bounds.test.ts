import { describe, expect, it, vi } from "vitest";
import {
  FILE_PART_BYTES,
  MAX_FILE_BYTES,
  MAX_FILE_PARTS,
  memoryObjectStore,
  openFile,
  readFileManifest,
  sealFile,
} from "./file-parts.js";

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
      { ...original, size: FILE_PART_BYTES + 1 },
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
      getObject: vi.fn(async () => new Uint8Array(FILE_PART_BYTES + 17)),
    };
    await expect(openFile(text, [oversized])).rejects.toThrow();
    const smaller = { ...JSON.parse(text), size: 3 };
    await expect(openFile(JSON.stringify(smaller), [store])).rejects.toThrow();
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
