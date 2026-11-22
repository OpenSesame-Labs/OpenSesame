import { describe, expect, it } from "vitest";
import {
  type FileManifest,
  MAX_ENCRYPTED_FILE_PART_BYTES,
  MAX_FILE_BYTES,
  MAX_FILE_MANIFEST_CHARS,
  MAX_FILE_PARTS,
  type ObjectStore,
  fileSummary,
  memoryObjectStore,
  openFile,
  readFileManifest,
  sealFile,
} from "./file-parts.js";

const PLAIN = "CANARY-PLAINTEXT-BYTES";

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function sealed(
  stores: readonly ObjectStore[],
  bytes = text(PLAIN),
): Promise<string> {
  return sealFile({
    name: "notes.txt",
    mediaType: "text/plain",
    bytes,
    stores,
    partBytes: 8,
  });
}

describe("file parts", () => {
  it("round-trips a file and keeps the plaintext out of the manifest", async () => {
    const store = memoryObjectStore();
    const manifest = await sealed([store]);
    expect(manifest.includes(PLAIN)).toBe(false);
    const summary = fileSummary(manifest);
    expect(summary).toEqual({
      name: "notes.txt",
      mediaType: "text/plain",
      size: text(PLAIN).byteLength,
    });
    expect(manifest.includes(summary?.name ?? "")).toBe(true);
    const opened = await openFile(manifest, [store]);
    expect(new TextDecoder().decode(opened.bytes)).toBe(PLAIN);
    const listed = await store.listObjects();
    expect(listed.length).toBeGreaterThan(1);
    const part = await store.getObject(listed[0] ?? "");
    expect(
      new TextDecoder().decode(part ?? new Uint8Array()).includes(PLAIN),
    ).toBe(false);
  });

  it("reads a part from the second store after the first loses it", async () => {
    const first = memoryObjectStore();
    const second = memoryObjectStore();
    const manifest = await sealed([first, second]);
    const summary = fileSummary(manifest);
    expect(summary).not.toBeNull();
    const parsed = readFileManifest(manifest);
    const partKey = parsed?.parts[0]?.key;
    if (partKey === undefined) throw new Error("file part is missing");
    await first.deleteObject(partKey);
    const opened = await openFile(manifest, [first, second]);
    expect(new TextDecoder().decode(opened.bytes)).toBe(PLAIN);
  });

  it("refuses parts that have been reordered", async () => {
    const store = memoryObjectStore();
    const manifest = await sealed([store]);
    const parsed = readFileManifest(manifest);
    const firstPart = parsed?.parts[0];
    const secondPart = parsed?.parts[1];
    if (
      parsed === undefined ||
      firstPart === undefined ||
      secondPart === undefined
    ) {
      throw new Error("file part is missing");
    }
    const rest: FileManifest["parts"][number][] = [];
    for (const part of parsed.parts.slice(2)) rest.push(part);
    const reordered: FileManifest = {
      v: 1,
      name: parsed.name,
      mediaType: parsed.mediaType,
      size: parsed.size,
      key: parsed.key,
      parts: [secondPart, firstPart, ...rest],
    };
    await expect(openFile(JSON.stringify(reordered), [store])).rejects.toThrow(
      "file part is missing",
    );
  });

  it("refuses a file over the size limit before writing a part", async () => {
    const store = memoryObjectStore();
    await expect(
      sealFile({
        name: "big.bin",
        mediaType: "application/octet-stream",
        bytes: text("12345"),
        stores: [store],
        maxBytes: 4,
      }),
    ).rejects.toThrow("file exceeds the size limit");
    expect(await store.listObjects()).toEqual([]);
  });

  it("rejects non-integer part and size limits before writing a part", async () => {
    const store = memoryObjectStore();
    const base = {
      name: "big.bin",
      mediaType: "application/octet-stream",
      bytes: text("12345"),
      stores: [store],
    };
    for (const partBytes of [Number.NaN, Number.POSITIVE_INFINITY, 0.5, 0]) {
      await expect(sealFile({ ...base, partBytes })).rejects.toThrow(
        "invalid file part size",
      );
    }
    for (const maxBytes of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5]) {
      await expect(sealFile({ ...base, maxBytes })).rejects.toThrow(
        "invalid file size limit",
      );
    }
    expect(await store.listObjects()).toEqual([]);
  });

  it("refuses attacker-sized manifests and part arrays before reading stores", async () => {
    const never: ObjectStore = {
      async putObject() {
        throw new Error("not reached");
      },
      async getObject() {
        throw new Error("not reached");
      },
    };
    const base = {
      v: 1,
      name: "x",
      mediaType: "application/octet-stream",
      key: `${"A".repeat(43)}=`,
      size: 1,
    } as const;
    expect(
      readFileManifest(" ".repeat(MAX_FILE_MANIFEST_CHARS + 1)),
    ).toBeUndefined();
    expect(
      readFileManifest(
        JSON.stringify({ ...base, size: MAX_FILE_BYTES + 1, parts: [] }),
      ),
    ).toBeUndefined();
    const ref = { key: "A".repeat(16), nonce: "A".repeat(16) };
    const tooMany = JSON.stringify({
      ...base,
      size: MAX_FILE_PARTS + 1,
      parts: Array.from({ length: MAX_FILE_PARTS + 1 }, () => ref),
    });
    expect(readFileManifest(tooMany)).toBeUndefined();
    await expect(openFile(tooMany, [never])).rejects.toThrow(
      "file part is missing",
    );

    const tooFewForClaimedSize = JSON.stringify({
      ...base,
      size: MAX_FILE_BYTES,
      parts: [ref],
    });
    expect(readFileManifest(tooFewForClaimedSize)).toBeUndefined();
    await expect(openFile(tooFewForClaimedSize, [never])).rejects.toThrow(
      "file part is missing",
    );
  });

  it("bounds generated part counts and retrieved ciphertext before decryption", async () => {
    const store = memoryObjectStore();
    await expect(
      sealFile({
        name: "many.bin",
        mediaType: "application/octet-stream",
        bytes: new Uint8Array(MAX_FILE_PARTS + 1),
        stores: [store],
        partBytes: 1,
      }),
    ).rejects.toThrow("file exceeds the part count limit");
    expect(await store.listObjects()).toEqual([]);

    const manifest = await sealFile({
      name: "one.bin",
      mediaType: "application/octet-stream",
      bytes: new Uint8Array([1]),
      stores: [store],
    });
    const oversized: ObjectStore = {
      async putObject() {},
      async getObject() {
        return new Uint8Array(MAX_ENCRYPTED_FILE_PART_BYTES + 1);
      },
    };
    await expect(openFile(manifest, [oversized])).rejects.toThrow(
      "file part is missing",
    );
  });

  it("seals an empty file with no parts", async () => {
    const store = memoryObjectStore();
    const manifest = await sealFile({
      name: "empty",
      mediaType: "application/octet-stream",
      bytes: new Uint8Array(),
      stores: [store],
    });
    expect(fileSummary(manifest)?.size).toBe(0);
    const opened = await openFile(manifest, [store]);
    expect(opened.bytes.byteLength).toBe(0);
    expect(await store.listObjects()).toEqual([]);
  });
});
