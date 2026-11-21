import { afterEach, describe, expect, it } from "vitest";
import {
  clearFrozenIntent,
  getTaskContext,
  noteReservedReceiptId,
  recordPendingInvocationRecovery,
  requireFrozenIntent,
  setTaskContext,
  updateTaskFromResponse,
} from "./task-context.js";

describe("task-context edges", () => {
  afterEach(() => {
    setTaskContext(null);
  });

  it("requireFrozenIntent returns the frozen intent when one is set", () => {
    const frozenIntent = {
      intentId: "i-1",
      intentDigest: "sha256:abc",
      operation: "read",
      resource: "r1",
      audience: "https://api.example.test",
      canonicalArguments: {},
    };
    setTaskContext({ taskRunId: "t-1", stateVersion: 1, frozenIntent });
    expect(requireFrozenIntent()).toEqual(frozenIntent);
  });

  it("ignores responses that do not describe a task state", () => {
    setTaskContext({ taskRunId: "t-1", stateVersion: 1 });

    updateTaskFromResponse({});
    updateTaskFromResponse({ task_run_id: "other" });
    updateTaskFromResponse({ state_version: 9 });

    expect(getTaskContext()).toEqual({ taskRunId: "t-1", stateVersion: 1 });
  });

  it("clearFrozenIntent is a no-op without an active task", () => {
    setTaskContext(null);
    expect(() => clearFrozenIntent()).not.toThrow();
    expect(getTaskContext()).toBeNull();
  });

  it("notes a receipt id only for the task that dispatched", () => {
    const intent = {
      intentId: "i-1",
      intentDigest: "sha256:abc",
      operation: "read",
      resource: "r1",
      audience: "https://api.example.test",
      canonicalArguments: {},
    };
    setTaskContext({ taskRunId: "t-1", stateVersion: 1, frozenIntent: intent });
    recordPendingInvocationRecovery(intent);
    clearFrozenIntent();
    noteReservedReceiptId("t-2", "018fbd8a-1e78-7a3c-9c24-1ebd832b8dcb");
    noteReservedReceiptId("t-1", "not-a-uuid");
    expect(
      getTaskContext()?.pendingInvocationRecovery?.reservedReceiptId,
    ).toBeUndefined();
    noteReservedReceiptId("t-1", "018fbd8a-1e78-7a3c-9c24-1ebd832b8dcb");
    expect(getTaskContext()?.pendingInvocationRecovery?.reservedReceiptId).toBe(
      "018fbd8a-1e78-7a3c-9c24-1ebd832b8dcb",
    );
  });

  it("keeps invocation recovery when the same task refreshes", () => {
    setTaskContext({
      taskRunId: "t-1",
      stateVersion: 1,
      pendingInvocationRecovery: {
        intentId: "i-1",
        intentDigest: "sha256:abc",
        operation: "read",
        resource: "r1",
        audience: "https://api.example.test",
      },
    });
    updateTaskFromResponse(
      { task_run_id: "t-1", state_version: 2 },
      { adopt: false },
    );
    expect(getTaskContext()?.pendingInvocationRecovery?.intentId).toBe("i-1");
    expect(getTaskContext()?.stateVersion).toBe(2);

    updateTaskFromResponse({ task_run_id: "t-2", state_version: 1 });
    expect(getTaskContext()?.taskRunId).toBe("t-2");
    expect(getTaskContext()?.pendingInvocationRecovery).toBeUndefined();
  });
});
