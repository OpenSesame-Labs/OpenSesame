import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
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
import { DRIVE_BODY_MAX_TIMEOUT_MS, readDriveBody } from "./drive-body.js";
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
  it("times out while a real loopback drive withholds response headers", async () => {
    let requests = 0;
    const server = createServer(() => {
      requests += 1;
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const { port } = z
        .object({ port: z.number().int().min(1).max(65_535) })
        .parse(server.address());
      await expect(
        reachDrive({ ...PAIRING, url: `http://127.0.0.1:${port}` }, 2000),
      ).rejects.toMatchObject({ name: "TimeoutError" });
      expect(requests).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

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

  it("allows a valid response to make progress for longer than the idle timeout", async () => {
    vi.useFakeTimers();
    let send: (bytes: Uint8Array) => void = () => {
      throw new Error("stream has not started");
    };
    let finish: () => void = () => {
      throw new Error("stream has not started");
    };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        send = (bytes) => controller.enqueue(bytes);
        finish = () => controller.close();
      },
    });
    driveClientSeams.fetch = async () => new Response(body);
    const pending = readDrive(PAIRING);
    void pending.catch(() => undefined);
    const bytes = new TextEncoder().encode('{"generation":1,"snapshot":null}');
    for (let offset = 0; offset < bytes.length; offset += 8) {
      await vi.advanceTimersByTimeAsync(10_000);
      send(bytes.subarray(offset, offset + 8));
      await vi.advanceTimersByTimeAsync(0);
    }
    finish();
    await expect(pending).resolves.toEqual({ generation: 1, snapshot: null });
  });

  it("times out a continuing trickle at the absolute transfer limit", async () => {
    vi.useFakeTimers();
    let send: (bytes: Uint8Array) => void = () => {
      throw new Error("stream has not started");
    };
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        send = (bytes) => controller.enqueue(bytes);
      },
      cancel,
    });
    const checked = expect(
      readDriveBody(new Response(body), 1024),
    ).rejects.toThrow("timed out");
    for (
      let elapsed = 10_000;
      elapsed < DRIVE_BODY_MAX_TIMEOUT_MS;
      elapsed += 10_000
    ) {
      await vi.advanceTimersByTimeAsync(10_000);
      send(new Uint8Array([1]));
      await vi.advanceTimersByTimeAsync(0);
    }
    await vi.advanceTimersByTimeAsync(10_000);
    await checked;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not count empty chunks as progress", async () => {
    vi.useFakeTimers();
    let send: (bytes: Uint8Array) => void = () => {
      throw new Error("stream has not started");
    };
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        send = (bytes) => controller.enqueue(bytes);
      },
      cancel,
    });
    const checked = expect(
      readDriveBody(new Response(body), 1024),
    ).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(10_000);
    send(new Uint8Array());
    await vi.advanceTimersByTimeAsync(DRIVE_TIMEOUT_MS - 10_000);
    await checked;
    expect(cancel).toHaveBeenCalledOnce();
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
    await expect(promptly(readDrive(PAIRING))).rejects.toThrow(
      "oversized body",
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["-1", "1.5", "9007199254740992"])(
    "preserves the part reader's rejection of invalid declared length (%s)",
    async (length) => {
      const { response, cancel } = neverFinishingResponse(200);
      const invalid = new Response(response.body, {
        headers: { "content-length": length },
      });
      driveClientSeams.fetch = async () => invalid;
      await expect(promptly(readDrivePart(PAIRING, part))).rejects.toThrow(
        "oversized body",
      );
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("counts snapshot bytes when the declared length is not a single decimal", async () => {
    driveClientSeams.fetch = async () =>
      new Response('{"generation":0,"snapshot":null}', {
        headers: { "content-length": "32, 32" },
      });
    await expect(readDrive(PAIRING)).resolves.toEqual({
      generation: 0,
      snapshot: null,
    });
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
    await expect(readDrive(PAIRING)).rejects.toThrow("oversized body");
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
    { name: "part list", status: 200, call: () => listDriveParts(PAIRING) },
    {
      name: "part read",
      status: 200,
      call: () => readDrivePart(PAIRING, part),
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
