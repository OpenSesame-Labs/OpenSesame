import { describe, expect, it } from "vitest";
import { TestResourceScope, withTestResources } from "./test-resources.js";

describe("test resource scope", () => {
  it("closes resources in reverse order after a successful test", async () => {
    const closed: string[] = [];
    const value = await withTestResources(async (scope) => {
      const first = {
        close: () => {
          closed.push("first");
        },
        value: 42,
      };
      expect(scope.use(first)).toBe(first);
      scope.use({
        close: async () => {
          closed.push("second");
        },
      });
      return first.value;
    });
    expect(value).toBe(42);
    expect(closed).toEqual(["second", "first"]);
  });

  it("closes resources acquired before setup or the test fails", async () => {
    const failure = new Error("setup failed");
    const closed: string[] = [];
    await expect(
      withTestResources((scope) => {
        scope.use({
          close: () => {
            closed.push("first");
          },
        });
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(closed).toEqual(["first"]);
  });

  it("waits for a concurrent startup to finish and closes it after another fails", async () => {
    const failure = new Error("startup failed");
    const closed: string[] = [];
    let finishStart: ((resource: { close(): void }) => void) | undefined;
    let announceStart: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      announceStart = resolve;
    });
    const run = withTestResources(async (scope) => {
      const slow = scope.acquire(
        () =>
          new Promise<{ close(): void }>((resolve) => {
            finishStart = resolve;
            announceStart?.();
          }),
      );
      const failed = scope.acquire(() => {
        throw failure;
      });
      return Promise.all([slow, failed]);
    });
    // Attach the rejection assertion before releasing the pending start.
    const rejected = expect(run).rejects.toBe(failure);
    await started;
    finishStart?.({
      close: () => {
        closed.push("slow");
      },
    });
    await rejected;
    expect(closed).toEqual(["slow"]);
  });

  it("continues cleanup after failures and preserves the test error", async () => {
    const testError = new Error("test failed");
    const firstError = new Error("first close failed");
    const secondError = new Error("second close failed");
    let caught: Error | undefined;
    try {
      await withTestResources((scope) => {
        scope.use({
          close: () => {
            throw firstError;
          },
        });
        scope.use({
          close: () => {
            throw secondError;
          },
        });
        throw testError;
      });
    } catch (error) {
      if (error instanceof Error) caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    if (!(caught instanceof AggregateError))
      throw new Error("expected AggregateError");
    expect(caught.errors[0]).toBe(testError);
    expect(caught.errors[1]).toBeInstanceOf(AggregateError);
    expect(caught.errors[1].errors).toEqual([secondError, firstError]);
  });

  it("closes only once and refuses registrations after cleanup begins", async () => {
    const scope = new TestResourceScope();
    let calls = 0;
    const resource = scope.use({
      close: async () => {
        calls += 1;
      },
    });
    expect(() => scope.use(scope)).toThrow(/cannot own itself/);
    expect(() => scope.use(resource)).toThrow(/already registered/);
    const firstClose = scope.close();
    expect(scope.close()).toBe(firstClose);
    expect(() => scope.use({ close: () => {} })).toThrow(/closed/);
    await firstClose;
    await scope.close();
    expect(calls).toBe(1);
  });
});
