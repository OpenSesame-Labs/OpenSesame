import { afterEach, describe, expect, it } from "vitest";
import { host } from "../host.js";
import { atRestReady } from "./at-rest/key.js";
import { openOriginFile, sealOriginFile } from "./at-rest/origin-files.js";
import { comparePublishOriginFile } from "./origin-file-publication.js";
import {
  fixture,
  name,
  restoreOriginPublicationFixture,
} from "./origin-file-publication-custody.test-support.js";

describe("custody", () => {
  /** Real device-key seals and native File snapshots; OPFS/stream delivery is doubled. */

  afterEach(restoreOriginPublicationFixture);
  const attacks = [
    ["root", "getFileHandle"],
    ["root", "isSameEntry"],
    ["root", "removeEntry"],
    ["handle", "getFile"],
    ["handle", "createWritable"],
    ["handle", "isSameEntry"],
    ["file", "text"],
    ["stream", "write"],
    ["stream", "close"],
    ["stream", "abort"],
  ];
  it.each(attacks)(
    "original callback cannot substitute captured %s.%s",
    async (phase, method) => {
      const f = fixture();
      const key = await atRestReady();
      expect(key.durable).toBe(true);
      const before = sealOriginFile(key, name, "old");
      f.files.set(name, before);
      let replaced = false;
      let maliciousCalls = 0;
      const original = () => {
        if (host() !== f.installed) throw new Error("Actual Host changed.");
        if (replaced || f.state.phase !== phase) return;
        const target =
          phase === "root"
            ? f.root
            : phase === "handle"
              ? f.state.handle
              : phase === "file"
                ? f.state.file
                : f.state.stream;
        if (!target) throw new Error("Actual delivered resource missing.");
        replaced = true;
        Object.defineProperty(target, method, {
          configurable: true,
          value: async () => {
            maliciousCalls += 1;
            return "forged readback";
          },
        });
      };
      await expect(
        comparePublishOriginFile(
          name,
          "old",
          "next",
          4096,
          original,
          f.directory,
        ),
      ).rejects.toThrow();
      expect(replaced).toBe(true);
      expect(maliciousCalls).toBe(0);
      expect(f.files.get(name)).toBe(before);
      expect(f.state.closed).toBe(0);
      expect(f.state.aborted).toBe(phase === "stream" ? 1 : 0);
    },
  );
  it("fixed original publication keeps actual device seal, readback and predecessor identity", async () => {
    const f = fixture();
    const key = await atRestReady();
    f.files.set(name, sealOriginFile(key, name, "old"));
    const current = await comparePublishOriginFile(
      name,
      "old",
      "next",
      4096,
      () => {
        if (host() !== f.installed) throw new Error("Actual Host changed.");
      },
      f.directory,
    );
    current();
    const wire = f.files.get(name);
    if (!wire) throw new Error("Actual published device seal missing.");
    expect(wire).not.toContain("next");
    expect(await openOriginFile(name, wire)).toBe("next");
    expect(f.state.closed).toBe(1);
    expect(f.state.aborted).toBe(0);
  });
  it("failed own write drains captured abort and removes only its empty placeholder", async () => {
    const f = fixture();
    f.state.failWrite = true;
    await expect(
      comparePublishOriginFile(name, null, "next", 4096, () => {}, f.directory),
    ).rejects.toThrow("Actual own write refused.");
    expect(f.state.aborted).toBe(1);
    expect(f.state.closed).toBe(0);
    expect(f.files.has(name)).toBe(false);
  });
  it("post-close callback refusal preserves the actual committed seal and never aborts it", async () => {
    const f = fixture();
    const key = await atRestReady();
    f.files.set(name, sealOriginFile(key, name, "old"));
    const original = () => {
      if (f.state.phase === "closed")
        throw new Error("Actual refusal after close.");
    };
    await expect(
      comparePublishOriginFile(
        name,
        "old",
        "next",
        4096,
        original,
        f.directory,
      ),
    ).rejects.toThrow("Actual refusal after close.");
    const wire = f.files.get(name);
    if (!wire) throw new Error("Actual committed seal missing.");
    expect(await openOriginFile(name, wire)).toBe("next");
    expect(f.state.closed).toBe(1);
    expect(f.state.aborted).toBe(0);
  });
  it("callback-substituted cleanup cannot invoke a replacement remover or publish its empty entry", async () => {
    const f = fixture();
    let maliciousCalls = 0;
    let replaced = false;
    const original = () => {
      if (replaced || f.state.phase !== "write") return;
      replaced = true;
      Object.defineProperty(f.root, "removeEntry", {
        configurable: true,
        value: async () => {
          maliciousCalls += 1;
        },
      });
    };
    await expect(
      comparePublishOriginFile(name, null, "next", 4096, original, f.directory),
    ).rejects.toThrow();
    expect(replaced).toBe(true);
    expect(maliciousCalls).toBe(0);
    expect(f.state.aborted).toBe(1);
    expect(f.state.closed).toBe(0);
    expect(f.files.get(name)).toBe("");
  });
});

describe("delivery", () => {
  /** Actual publisher/crypto; only returned stream slots and method.call delivery are doubled. */

  afterEach(restoreOriginPublicationFixture);
  function gate() {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { pending, release };
  }
  function refuse<T>(failures: readonly T[]) {
    if (failures.length === 1) throw failures[0];
    if (failures.length)
      throw new AggregateError(
        failures,
        "Original delivery control and cleanup failed.",
      );
  }
  it.each([
    { slot: "write", abortFailure: undefined },
    { slot: "close", abortFailure: undefined },
    {
      slot: "write",
      abortFailure: { cause: new Error("Actual abort refused.") },
    },
    { slot: "close", abortFailure: { cause: undefined } },
  ])(
    "retains delivered abort through $slot capture refusal",
    async ({ slot, abortFailure }) => {
      const entered = gate();
      const released = gate();
      const workCause = new Error("Actual writable slot delivery refused.");
      const f = fixture((stream) => {
        const abort = stream.abort;
        stream.abort = async () => {
          await abort();
          entered.release();
          await released.pending;
          if (abortFailure) throw abortFailure.cause;
        };
        Object.defineProperty(stream, slot, {
          configurable: true,
          get: () => {
            throw workCause;
          },
        });
      });
      let settled = false;
      const task = comparePublishOriginFile(
        name,
        null,
        "next",
        4096,
        () => {},
        f.directory,
      );
      const outcome = task.then(
        () => {
          settled = true;
          return { status: "fulfilled" as const };
        },
        (cause: unknown) => {
          settled = true;
          return { status: "rejected" as const, cause };
        },
      );
      const failures: unknown[] = [];
      let verified = false;
      try {
        await Promise.race([
          entered.pending,
          outcome.then(() => {
            throw new Error("Actual abort never entered.");
          }),
        ]);
        expect(settled).toBe(false);
        released.release();
        const result = await outcome;
        expect(result.status).toBe("rejected");
        if (result.status !== "rejected")
          throw new Error("Actual capture unexpectedly succeeded.");
        if (abortFailure) {
          expect(result.cause).toBeInstanceOf(AggregateError);
          if (!(result.cause instanceof AggregateError))
            throw new Error("Actual paired causes missing.");
          expect(result.cause.errors).toHaveLength(2);
          expect(result.cause.errors[0]).toBe(workCause);
          expect(result.cause.errors[1]).toBe(abortFailure.cause);
        } else expect(result.cause).toBe(workCause);
        expect(f.state.aborted).toBe(1);
        expect(f.state.closed).toBe(0);
        expect(f.files.has(name)).toBe(false);
        verified = true;
      } catch (cause) {
        failures.push(cause);
      } finally {
        released.release();
        const result = await outcome;
        if (!verified && result.status === "rejected")
          failures.push(result.cause);
      }
      refuse(failures);
    },
  );
  function poisonCall<T extends object>(method: T, invoked: () => void) {
    const original = Object.getOwnPropertyDescriptor(method, "call");
    const restore = () => {
      if (original) Object.defineProperty(method, "call", original);
      else if (!Reflect.deleteProperty(method, "call"))
        throw new Error("Actual method.call restoration failed.");
    };
    try {
      Object.defineProperty(method, "call", {
        configurable: true,
        value: async () => {
          invoked();
          throw new Error("Forged method.call executed.");
        },
      });
    } catch (cause) {
      try {
        restore();
      } catch (cleanup) {
        throw new AggregateError(
          [cause, cleanup],
          "Actual poison setup and restoration failed.",
        );
      }
      throw cause;
    }
    return restore;
  }
  it.each([false, true])(
    "fixed native dispatch ignores own call poisoning (write refusal %s)",
    async (failWrite) => {
      const f = fixture();
      f.state.failWrite = failWrite;
      const key = await atRestReady();
      const before = sealOriginFile(key, name, "old");
      f.files.set(name, before);
      const poisoned = new WeakSet<object>();
      const restore: (() => void)[] = [];
      let maliciousCalls = 0;
      let poisonedMethods = 0;
      const original = () => {
        const methods = [
          f.installed.originFiles,
          f.root.getFileHandle,
          f.root.isSameEntry,
          f.root.removeEntry,
          f.state.handle?.getFile,
          f.state.handle?.createWritable,
          f.state.handle?.isSameEntry,
          f.state.file?.text,
          f.state.stream?.write,
          f.state.stream?.close,
          f.state.stream?.abort,
        ];
        for (const method of methods) {
          if (!method || poisoned.has(method)) continue;
          restore.push(
            poisonCall(method, () => {
              maliciousCalls += 1;
            }),
          );
          poisoned.add(method);
          poisonedMethods += 1;
        }
      };
      const failures: unknown[] = [];
      const task = comparePublishOriginFile(
        name,
        "old",
        "next",
        4096,
        original,
        f.directory,
      );
      const outcome = task.then(
        (value) => ({ status: "fulfilled" as const, value }),
        (cause: unknown) => ({ status: "rejected" as const, cause }),
      );
      try {
        if (failWrite)
          await expect(task).rejects.toThrow("Actual own write refused.");
        else (await task)();
        expect(poisonedMethods).toBeGreaterThan(0);
        expect(maliciousCalls).toBe(0);
        expect(f.state.aborted).toBe(failWrite ? 1 : 0);
        expect(f.state.closed).toBe(failWrite ? 0 : 1);
        if (failWrite) expect(f.files.get(name)).toBe(before);
        else
          expect(await openOriginFile(name, f.files.get(name) ?? "")).toBe(
            "next",
          );
      } catch (cause) {
        failures.push(cause);
      } finally {
        for (const close of restore.reverse()) {
          try {
            close();
          } catch (cause) {
            failures.push(cause);
          }
        }
      }
      const result = await outcome;
      if (failures.length && result.status === "rejected")
        failures.push(result.cause);
      refuse(failures);
    },
  );
});
