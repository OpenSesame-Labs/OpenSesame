import { overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost } from "../../../../host.js";
import { createTestHost } from "../../../../test-host.js";
import { cappedArgon2Impl } from "./kdbx-argon2.js";
import { isolatedArgon2 } from "./kdbx-argon2-worker-client.js";

type WorkSent = {
  variant: string;
  memorySize: number;
  iterations: number;
  password: ArrayBuffer;
  salt: ArrayBuffer;
};

class StubWorker {
  static instances: StubWorker[] = [];
  static failPost = false;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn((_work: WorkSent, _transfers: ArrayBuffer[]) => {
    if (StubWorker.failPost) throw new Error("worker secret diagnostic");
  });
  terminate = vi.fn();
  constructor() {
    StubWorker.instances.push(this);
  }
}

const password = new Uint8Array(32).fill(7);
const salt = new Uint8Array(32).fill(9);
const derive = cappedArgon2Impl(isolatedArgon2, 2);
const start = () =>
  derive(password.buffer, salt.buffer, 1024, 1, 32, 1, 2, 0x13);

beforeEach(() => {
  StubWorker.instances = [];
  StubWorker.failPost = false;
  configureHost(createTestHost({ worker: overlapCast(StubWorker) }));
});

afterEach(() => {
  vi.useRealTimers();
  configureHost(createTestHost());
});

it("derives in an isolated worker and terminates it after a valid reply", async () => {
  const pending = start();
  const worker = StubWorker.instances[0];
  expect(worker).toBeDefined();
  const [work, transfers] = worker.postMessage.mock.calls[0];
  expect(work).toMatchObject({
    variant: "id",
    memorySize: 1024,
    iterations: 1,
  });
  expect(work.password).not.toBe(password.buffer);
  expect(work.salt).not.toBe(salt.buffer);
  expect(transfers).toEqual([work.password, work.salt]);
  worker.onmessage?.(
    overlapCast({ data: { hash: new Uint8Array(32).fill(3).buffer } }),
  );
  expect(new Uint8Array(await pending)).toEqual(new Uint8Array(32).fill(3));
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(password).toEqual(new Uint8Array(32).fill(7));
});

it("terminates a stalled worker at the deadline and admits a later attempt", async () => {
  vi.useFakeTimers();
  const stalled = start();
  const failure = expect(stalled).rejects.toThrow(/took too long/);
  await expect(start()).rejects.toThrow(/already opening/);
  expect(StubWorker.instances).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(30_000);
  await failure;
  expect(StubWorker.instances[0].terminate).toHaveBeenCalledOnce();
  const retry = start();
  const next = StubWorker.instances[1];
  next.onmessage?.(overlapCast({ data: { hash: new ArrayBuffer(32) } }));
  await expect(retry).resolves.toEqual(new ArrayBuffer(32));
  expect(next.terminate).toHaveBeenCalledOnce();
});

it("fails closed on malformed worker replies and absent worker support", async () => {
  const pending = start();
  StubWorker.instances[0].onmessage?.(
    overlapCast({ data: { hash: new ArrayBuffer(31) } }),
  );
  await expect(pending).rejects.toThrow(/could not be opened/);
  expect(StubWorker.instances[0].terminate).toHaveBeenCalledOnce();
  configureHost(createTestHost({ worker: undefined }));
  await expect(start()).rejects.toThrow(/cannot safely open/);
});

it("rejects over-budget parameters before starting a worker", async () => {
  await expect(
    derive(password.buffer, salt.buffer, 65_537, 1, 32, 1, 2, 0x13),
  ).rejects.toThrow(/work budget/);
  expect(StubWorker.instances).toHaveLength(0);
});

it("terminates after worker startup and messaging failures without returning diagnostics", async () => {
  const interrupted = start();
  StubWorker.instances[0].onerror?.();
  await expect(interrupted).rejects.toThrow(/could not start/);
  expect(StubWorker.instances[0].terminate).toHaveBeenCalledOnce();
  StubWorker.failPost = true;
  await expect(start()).rejects.toThrow(/could not start/);
  expect(StubWorker.instances[1].terminate).toHaveBeenCalledOnce();
});
