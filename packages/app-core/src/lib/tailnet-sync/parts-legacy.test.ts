/**
 * A legacy v1 part (up to the drive daemon's former 1 MiB + 1,024 bytes) can
 * still be read from the drive, but nothing writes one: puts stay at the
 * strict 1 MiB + 16 bytes, and a sync pass leaves a legacy part where it is.
 */
import {
  MAX_ENCRYPTED_FILE_PART_BYTES,
  MAX_LEGACY_ENCRYPTED_FILE_PART_BYTES,
  type VaultItem,
  createItem,
} from "@opensesame/vault-core";
import { afterEach, describe, expect, it } from "vitest";
import { driveClientSeams } from "./client.js";
import { PAIRING } from "./drive.fixture.js";
import { putMissingParts, readDrivePart, writeDrivePart } from "./parts.js";

const original = driveClientSeams.fetch;
const KEY = "AbCdEfGhIjKl-_09";

afterEach(() => {
  driveClientSeams.fetch = original;
});

function legacyManifest(): string {
  return JSON.stringify({
    v: 1,
    name: "legacy.bin",
    mediaType: "application/octet-stream",
    size: MAX_LEGACY_ENCRYPTED_FILE_PART_BYTES - 16,
    key: `${"A".repeat(43)}=`,
    parts: [{ key: KEY, nonce: "A".repeat(16) }],
  });
}

describe("legacy drive parts", () => {
  it("reads a part at the daemon's former limit and refuses one beyond it", async () => {
    const legacy = new Uint8Array(MAX_LEGACY_ENCRYPTED_FILE_PART_BYTES);
    legacy[0] = 42;
    legacy[legacy.length - 1] = 17;
    let body = legacy;
    driveClientSeams.fetch = async () => new Response(body);
    expect(await readDrivePart(PAIRING, KEY)).toEqual(legacy);
    body = new Uint8Array(MAX_LEGACY_ENCRYPTED_FILE_PART_BYTES + 1);
    await expect(readDrivePart(PAIRING, KEY)).rejects.toThrow("oversized body");
  });

  it("never writes a legacy-sized part", async () => {
    const puts: number[] = [];
    driveClientSeams.fetch = async (_url, init) => {
      if (init.method === "PUT" && init.body instanceof Uint8Array)
        puts.push(init.body.byteLength);
      return new Response(null, { status: 204 });
    };
    await writeDrivePart(
      PAIRING,
      KEY,
      new Uint8Array(MAX_ENCRYPTED_FILE_PART_BYTES),
    );
    await expect(
      writeDrivePart(
        PAIRING,
        KEY,
        new Uint8Array(MAX_ENCRYPTED_FILE_PART_BYTES + 1),
      ),
    ).rejects.toThrow("size limit");
    expect(puts).toEqual([MAX_ENCRYPTED_FILE_PART_BYTES]);
  });

  it("skips a held legacy part during sync instead of failing every pass", async () => {
    const requests: string[] = [];
    driveClientSeams.fetch = async (url, init) => {
      requests.push(`${init.method ?? "GET"} ${url}`);
      return url.endsWith("/parts")
        ? Response.json({ parts: [] })
        : new Response(null, { status: 204 });
    };
    const item: VaultItem = {
      ...createItem("note", "Old attachment"),
      fields: [
        { id: "f", name: "File", value: legacyManifest(), hidden: false },
      ],
    };
    const local = {
      async putObject() {},
      async getObject() {
        return new Uint8Array(MAX_LEGACY_ENCRYPTED_FILE_PART_BYTES);
      },
    };
    expect(await putMissingParts(PAIRING, [item], local)).toBe(0);
    expect(requests.some((line) => line.startsWith("PUT"))).toBe(false);
  });
});
