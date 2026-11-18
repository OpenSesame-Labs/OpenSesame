import { afterEach, describe, expect, it, vi } from "vitest";
import spec from "../../../../../spec/conformance/vault-drive-protocol.json" with {
  type: "json",
};
import {
  DRIVE_TIMEOUT_MS,
  MAX_DRIVE_JSON_BYTES,
  driveClientSeams,
  reachDrive,
  readDrive,
  writeDrive,
} from "./client.js";
import { PAIRING } from "./drive.fixture.js";
import { readDriveBody } from "./drive-body.js";
import { listDriveParts, readDrivePart, writeDrivePart } from "./parts.js";
import { DRIVE_SNAPSHOT_FORMAT, type DriveSnapshot } from "./snapshot.js";

const originalFetch = driveClientSeams.fetch;
const part = "AbCdEfGhIjKl-_09";
const snapshot: DriveSnapshot = {
  format: DRIVE_SNAPSHOT_FORMAT,
  v: 1,
  tomb: "personal",
  header: { v: 1, createdAt: "2026-01-01T00:00:00.000Z" },
  body: { ivB64: "aXY=", ctB64: "Y3Q=" },
  rev: 1,
};

afterEach(() => {
  driveClientSeams.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function promptly<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("operation waited for cancellation")),
          1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function neverFinishingResponse(status: number) {
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const body = new ReadableStream<Uint8Array>({ cancel });
  return { response: new Response(body, { status }), cancel };
}

describe("discarding unused drive responses", () => {
  it.each([
    {
      name: "part list failure",
      status: 503,
      call: () => listDriveParts(PAIRING),
      fails: true,
    },
    {
      name: "missing part",
      status: 404,
      call: () => readDrivePart(PAIRING, part),
      fails: false,
    },
    {
      name: "part read failure",
      status: 503,
      call: () => readDrivePart(PAIRING, part),
      fails: true,
    },
    {
      name: "part write success",
      status: 200,
      call: () => writeDrivePart(PAIRING, part, new Uint8Array([1])),
      fails: false,
    },
    {
      name: "part write failure",
      status: 503,
      call: () => writeDrivePart(PAIRING, part, new Uint8Array([1])),
      fails: true,
    },
    {
      name: "reach success",
      status: 200,
      call: () => reachDrive(PAIRING, 1000),
      fails: false,
    },
    {
      name: "reach failure",
      status: 401,
      call: () => reachDrive(PAIRING, 1000),
      fails: true,
    },
    {
      name: "snapshot read failure",
      status: 503,
      call: () => readDrive(PAIRING),
      fails: true,
    },
    {
      name: "snapshot write failure",
      status: 503,
      call: () => writeDrive(PAIRING, 0, snapshot),
      fails: true,
    },
  ])(
    "cancels $name without awaiting the peer",
    async ({ status, call, fails }) => {
      const { response, cancel } = neverFinishingResponse(status);
      driveClientSeams.fetch = async () => response;
      if (fails) {
        await expect(promptly<unknown>(call())).rejects.toMatchObject({
          status,
        });
      } else {
        await expect(promptly<unknown>(call())).resolves.toBe(
          status === 404 ? null : undefined,
        );
      }
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("ignores cancellation rejection without masking the drive error", async () => {
    const cancel = vi.fn(async () => {
      throw new Error("peer refused cancellation");
    });
    driveClientSeams.fetch = async () =>
      new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 503 });
    await expect(listDriveParts(PAIRING)).rejects.toMatchObject({
      status: 503,
    });
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("bounded snapshot responses", () => {
  it("keeps byte accounting correct across many tiny fragments", async () => {
    let sent = 0;
    const total = 20_000;
    const byte = new Uint8Array([42]);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === total) controller.close();
        else {
          sent += 1;
          controller.enqueue(byte);
        }
      },
    });
    const result = await readDriveBody(new Response(body), total);
    expect(result.byteLength).toBe(total);
    expect(result[0]).toBe(42);
    expect(result.at(-1)).toBe(42);
  });

  it("accepts a snapshot at the daemon's 16 MiB stored limit", async () => {
    const empty = { ...snapshot, body: { ...snapshot.body, ctB64: "" } };
    const bytesInEmpty = new TextEncoder().encode(
      JSON.stringify(empty),
    ).byteLength;
    const payload = "A".repeat(spec.limits.maxSnapshotBytes - bytesInEmpty);
    const maximal = { ...empty, body: { ...empty.body, ctB64: payload } };
    expect(new TextEncoder().encode(JSON.stringify(maximal)).byteLength).toBe(
      spec.limits.maxSnapshotBytes,
    );
    driveClientSeams.fetch = async () =>
      Response.json({ generation: 1, snapshot: maximal });
    const result = await readDrive(PAIRING);
    expect(result.generation).toBe(1);
    expect(result.snapshot?.body.ctB64.length).toBe(payload.length);
  });

  it("rejects an oversized declared JSON response without waiting for cancellation", async () => {
    const { response, cancel } = neverFinishingResponse(200);
    const oversized = new Response(response.body, {
      status: 200,
      headers: { "content-length": String(MAX_DRIVE_JSON_BYTES + 1) },
    });
    driveClientSeams.fetch = async () => oversized;
    await expect(promptly(readDrive(PAIRING))).rejects.toThrow("size limit");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds chunked JSON even when its content length is false", async () => {
    let chunks = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks += 1;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel,
    });
    driveClientSeams.fetch = async () =>
      new Response(body, { headers: { "content-length": "1" } });
    await expect(readDrive(PAIRING)).rejects.toThrow("size limit");
    expect(chunks).toBeLessThanOrEqual(18);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "snapshot read", status: 200, call: () => readDrive(PAIRING) },
    {
      name: "snapshot write",
      status: 200,
      call: () => writeDrive(PAIRING, 0, snapshot),
    },
    {
      name: "generation conflict",
      status: 409,
      call: () => writeDrive(PAIRING, 0, snapshot),
    },
  ])("times out and cancels a stalled $name body", async ({ status, call }) => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => {}),
      cancel,
    });
    driveClientSeams.fetch = async () => new Response(body, { status });
    const checked = expect(call()).rejects.toThrow("timed out");
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(DRIVE_TIMEOUT_MS);
    await checked;
    expect(cancel).toHaveBeenCalledOnce();
  });
});
