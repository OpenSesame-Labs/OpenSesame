import { MAX_FILE_PART_CIPHERTEXT_BYTES } from "@opensesame/vault-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DRIVE_TIMEOUT_MS, driveClientSeams } from "./client.js";
import { PAIRING } from "./drive.fixture.js";
import { listDriveParts, readDrivePart, writeDrivePart } from "./parts.js";
import { MAX_DRIVE_PARTS, readPartResponse } from "./parts-bounds.js";

const originalFetch = driveClientSeams.fetch;
afterEach(() => {
  driveClientSeams.fetch = originalFetch;
  vi.useRealTimers();
});

describe("untrusted drive responses", () => {
  it("reads and replicates a legacy part at the daemon's previous limit", async () => {
    const bytes = new Uint8Array(MAX_FILE_PART_CIPHERTEXT_BYTES);
    bytes[0] = 42;
    bytes[bytes.length - 1] = 17;
    const written: Uint8Array[] = [];
    driveClientSeams.fetch = async (_url, init) => {
      if (init.method === "PUT") {
        if (init.body instanceof Uint8Array) written.push(init.body);
        return new Response(null, { status: 204 });
      }
      return new Response(bytes);
    };
    await writeDrivePart(PAIRING, "AbCdEfGhIjKl-_09", bytes);
    expect(written).toHaveLength(1);
    expect(written[0]?.length).toBe(bytes.length);
    expect(written[0]?.every((byte, index) => byte === bytes[index])).toBe(
      true,
    );
    const received = await readDrivePart(PAIRING, "AbCdEfGhIjKl-_09");
    expect(received?.length).toBe(bytes.length);
    expect(received?.every((byte, index) => byte === bytes[index])).toBe(true);
    await expect(
      writeDrivePart(
        PAIRING,
        "AbCdEfGhIjKl-_09",
        new Uint8Array(MAX_FILE_PART_CIPHERTEXT_BYTES + 1),
      ),
    ).rejects.toThrow("size limit");
    expect(written).toHaveLength(1);
  });

  it("rejects an oversized declared part without reading it", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    driveClientSeams.fetch = async () =>
      new Response(stream, {
        headers: {
          "content-length": String(MAX_FILE_PART_CIPHERTEXT_BYTES + 1),
        },
      });
    await expect(readDrivePart(PAIRING, "AbCdEfGhIjKl-_09")).rejects.toThrow(
      "size limit",
    );
    expect(cancel).toHaveBeenCalled();
  });

  it("stops a chunked part that exceeds its advertised size", async () => {
    const cancel = vi.fn();
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new Uint8Array(MAX_FILE_PART_CIPHERTEXT_BYTES));
        } else controller.enqueue(new Uint8Array(1));
      },
      cancel,
    });
    driveClientSeams.fetch = async () =>
      new Response(stream, { headers: { "content-length": "1" } });
    await expect(readDrivePart(PAIRING, "AbCdEfGhIjKl-_09")).rejects.toThrow(
      "size limit",
    );
    expect(cancel).toHaveBeenCalled();
  });

  it("bounds part lists and rejects malformed entries", async () => {
    driveClientSeams.fetch = async () =>
      Response.json({
        parts: Array(MAX_DRIVE_PARTS + 1).fill("AbCdEfGhIjKl-_09"),
      });
    await expect(listDriveParts(PAIRING)).rejects.toThrow("invalid part list");
    driveClientSeams.fetch = async () =>
      Response.json({ parts: ["../../secret"] });
    await expect(listDriveParts(PAIRING)).rejects.toThrow("invalid part list");
  });

  it("times out when the response body stalls", async () => {
    vi.useFakeTimers();
    const stream = new ReadableStream<Uint8Array>({
      pull: () => new Promise(() => {}),
    });
    const result = readPartResponse(new Response(stream), 10);
    const checked = expect(result).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(DRIVE_TIMEOUT_MS);
    await checked;
  });
});
