/** Node-only test transport; browser coverage runs the actual worker. */
import { overlapCast } from "@opensesame/os-domain";
import { argon2d, argon2id } from "hash-wasm";
import { configureHost } from "../../../../host.js";
import { createTestHost } from "../../../../test-host.js";

type Work = {
  variant: "d" | "id";
  password: ArrayBuffer;
  salt: ArrayBuffer;
  parallelism: number;
  iterations: number;
  memorySize: number;
  hashLength: number;
};

class TestWorker {
  onmessage: ((event: MessageEvent<{ hash: ArrayBuffer }>) => void) | null =
    null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  private ended = false;

  postMessage(work: Work): void {
    const { variant, password, salt, ...parameters } = work;
    void (async () => {
      try {
        const hash = await (variant === "id" ? argon2id : argon2d)({
          ...parameters,
          password: new Uint8Array(password),
          salt: new Uint8Array(salt),
          outputType: "binary",
        });
        if (!this.ended)
          this.onmessage?.(
            overlapCast({ data: { hash: new Uint8Array(hash).buffer } }),
          );
      } catch {
        if (!this.ended) this.onerror?.();
      }
    })();
  }

  terminate(): void {
    this.ended = true;
  }
}

export function installKdbxTestWorker(): void {
  configureHost(createTestHost({ worker: overlapCast(TestWorker) }));
}
