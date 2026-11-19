import { overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost } from "../../../../host.js";
import { createTestHost } from "../../../../test-host.js";
import { cappedArgon2Impl } from "./kdbx-argon2.js";
import {
  isolatedAes,
  isolatedArgon2,
  withKdbxLoad,
} from "./kdbx-argon2-worker-client.js";

type WorkSent = {
  variant: string;
  memorySize: number;
  iterations: number;
  rounds?: number;
  password: ArrayBuffer;
  salt: ArrayBuffer;
};

type WorkerReply = { hash: ArrayBuffer } | null;

class StubWorker {
  static instances: StubWorker[] = [];
  static failPost = false;
  static failTerminate = false;
  onmessage: ((event: MessageEvent<WorkerReply>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn((_work: WorkSent, _transfers: ArrayBuffer[]) => {
    if (StubWorker.failPost) throw new Error("worker secret diagnostic");
  });
  terminate = vi.fn(() => {
    if (StubWorker.failTerminate) throw new Error("worker secret diagnostic");
  });
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
  StubWorker.failTerminate = false;
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

it("runs the AES encryptor in the same disposable worker without transferring caller buffers", async () => {
  const pending = isolatedAes(password, salt.buffer, 1234);
  const worker = StubWorker.instances[0];
  const [work, transfers] = worker.postMessage.mock.calls[0];
  expect(work).toMatchObject({ variant: "aes", rounds: 1234 });
  expect(work.password).not.toBe(password.buffer);
  expect(work.salt).not.toBe(salt.buffer);
  expect(transfers).toEqual([work.password, work.salt]);
  worker.onmessage?.(
    overlapCast({ data: { hash: new Uint8Array(32).fill(4).buffer } }),
  );
  await expect(pending).resolves.toEqual(new Uint8Array(32).fill(4));
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(password).toEqual(new Uint8Array(32).fill(7));
  expect(salt).toEqual(new Uint8Array(32).fill(9));
});

it("shares one KDF slot across AES and Argon2 and releases it after timeout", async () => {
  vi.useFakeTimers();
  const aes = isolatedAes(password, salt, 100);
  const timeout = expect(aes).rejects.toThrow(/took too long/);
  await expect(start()).rejects.toThrow(/already opening/);
  await expect(isolatedAes(password, salt, 100)).rejects.toThrow(
    /already opening/,
  );
  expect(StubWorker.instances).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(30_000);
  await timeout;
  expect(StubWorker.instances[0].terminate).toHaveBeenCalledOnce();
  const argon = start();
  await expect(isolatedAes(password, salt, 100)).rejects.toThrow(
    /already opening/,
  );
  StubWorker.instances[1].onmessage?.(
    overlapCast({ data: { hash: new ArrayBuffer(32) } }),
  );
  await expect(argon).resolves.toEqual(new ArrayBuffer(32));
  expect(StubWorker.instances[1].terminate).toHaveBeenCalledOnce();
});

it("rejects malformed or over-budget AES work before opening a worker", () => {
  for (const rounds of [0, -1, Number.NaN, 1.5, 2 ** 24 + 1]) {
    expect(() => isolatedAes(password, salt, rounds)).toThrow(/key derivation/);
  }
  expect(() => isolatedAes(new Uint8Array(31), salt, 1)).toThrow(
    /key derivation/,
  );
  expect(() => isolatedAes(password, new Uint8Array(31), 1)).toThrow(
    /key derivation/,
  );
  expect(StubWorker.instances).toHaveLength(0);
});

it("admits the existing maximum AES round count", async () => {
  const pending = isolatedAes(password, salt, 2 ** 24);
  const worker = StubWorker.instances[0];
  expect(worker.postMessage.mock.calls[0][0]).toMatchObject({
    rounds: 2 ** 24,
  });
  worker.onmessage?.(overlapCast({ data: { hash: new ArrayBuffer(32) } }));
  await expect(pending).resolves.toEqual(new Uint8Array(32));
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it.each(["aes", "argon2"] as const)(
  "cancels only the owning %s operation and admits a later import",
  async (variant) => {
    const first = new AbortController();
    const other = new AbortController();
    const remove = vi.spyOn(first.signal, "removeEventListener");
    const pending = withKdbxLoad(first.signal, () =>
      variant === "aes"
        ? isolatedAes(password, salt, 1)
        : isolatedArgon2.argon2id({
            password,
            salt,
            parallelism: 1,
            iterations: 1,
            memorySize: 1024,
            hashLength: 32,
            outputType: "binary",
          }),
    );
    await expect(withKdbxLoad(other.signal, async () => null)).rejects.toThrow(
      /already opening/,
    );
    other.abort();
    expect(StubWorker.instances[0].terminate).not.toHaveBeenCalled();
    first.abort();
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(StubWorker.instances[0].terminate).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    const retry = withKdbxLoad(undefined, () => isolatedAes(password, salt, 1));
    StubWorker.instances[1].onmessage?.(
      overlapCast({ data: { hash: new ArrayBuffer(32) } }),
    );
    await expect(retry).resolves.toEqual(new Uint8Array(32));
  },
);

it("does not start a load whose owner has already dismissed it", async () => {
  const controller = new AbortController();
  controller.abort();
  const open = vi.fn(async () => isolatedAes(password, salt, 1));
  await expect(withKdbxLoad(controller.signal, open)).rejects.toThrow(
    /cancelled/,
  );
  expect(open).not.toHaveBeenCalled();
  expect(StubWorker.instances).toHaveLength(0);
});

it("does not return a completed parse after its owner cancels", async () => {
  const controller = new AbortController();
  let finish: () => void = () => undefined;
  const pending = withKdbxLoad(
    controller.signal,
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  controller.abort();
  finish();
  await expect(pending).rejects.toThrow(/cancelled/);
  await expect(withKdbxLoad(undefined, async () => "ready")).resolves.toBe(
    "ready",
  );
});

it("removes a completed load's abort listener before a later worker starts", async () => {
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const first = withKdbxLoad(controller.signal, () =>
    isolatedAes(password, salt, 1),
  );
  StubWorker.instances[0].onmessage?.(
    overlapCast({ data: { hash: new ArrayBuffer(32) } }),
  );
  await first;
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  const second = withKdbxLoad(undefined, () => isolatedAes(password, salt, 1));
  controller.abort();
  expect(StubWorker.instances[1].terminate).not.toHaveBeenCalled();
  StubWorker.instances[1].onmessage?.(
    overlapCast({ data: { hash: new ArrayBuffer(32) } }),
  );
  await expect(second).resolves.toEqual(new Uint8Array(32));
});

it("keeps the shared slot closed if a worker cannot be stopped", async () => {
  StubWorker.failTerminate = true;
  const pending = isolatedAes(password, salt, 1);
  StubWorker.instances[0].onmessage?.(
    overlapCast({ data: { hash: new ArrayBuffer(32) } }),
  );
  await expect(pending).rejects.toThrow(/could not stop safely/);
  await expect(start()).rejects.toThrow(/already opening/);
  expect(StubWorker.instances).toHaveLength(1);
});
