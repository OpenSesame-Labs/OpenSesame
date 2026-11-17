import { type BusEvent, MemoryTaskBus, type TaskBus } from "../taskBus.js";

export interface TestTaskBusOptions {
  /** One success or failure per publish; exhaustion refuses the next publish. */
  publishScript?: readonly ("success" | Error)[];
}

export interface TestTaskBus extends TaskBus {
  /** Every attempted event, including failed attempts. */
  readonly attempts: readonly BusEvent[];
  /** Events accepted by the underlying in-memory bus. */
  readonly published: readonly BusEvent[];
  /** Clear recordings and rewind the script. */
  reset(): void;
  /** Clear recordings and refuse further use. */
  close(): Promise<void>;
}

/** Fault-injecting TaskBus for unit tests; it does not emulate JetStream. */
export function createTestTaskBus(
  options: TestTaskBusOptions = {},
): TestTaskBus {
  const delegate = new MemoryTaskBus();
  const script = options.publishScript?.slice();
  const attempts: BusEvent[] = [];
  let nextPublish = 0;
  let closed = false;
  const assertOpen = () => {
    if (closed) throw new Error("test TaskBus is closed");
  };
  const reset = () => {
    assertOpen();
    attempts.length = 0;
    delegate.published.length = 0;
    nextPublish = 0;
  };
  return {
    get attempts() {
      return structuredClone(attempts);
    },
    get published() {
      return structuredClone(delegate.published);
    },
    async publish(event) {
      assertOpen();
      attempts.push(structuredClone(event));
      if (script) {
        const step = script[nextPublish++];
        if (step === undefined) {
          throw new Error("test TaskBus publish script exhausted");
        }
        if (step instanceof Error) throw step;
        if (step !== "success") {
          throw new Error(
            "test TaskBus publish script contains an invalid step",
          );
        }
      }
      await delegate.publish(structuredClone(event));
    },
    reset,
    async close() {
      if (!closed) {
        reset();
        closed = true;
      }
    },
  };
}
