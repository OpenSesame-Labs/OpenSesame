import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockAgentHeaders } from "./agent-headers-fixture.js";
import { resetFetchForTests, setFetchForTests } from "./host-api.js";
import { freezeHandler, resultSchema } from "./receipt-outcome-fixture.js";
import { getTaskContext, setTaskContext } from "./task-context.js";

describe("task_invoke freeze handling", () => {
  const originalHost = process.env.OPENSESAME_HOST_API;

  beforeEach(() => {
    process.env.OPENSESAME_HOST_API = "http://127.0.0.1:8787";
    mockAgentHeaders();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetFetchForTests();
    setTaskContext(null);
    if (originalHost === undefined) delete process.env.OPENSESAME_HOST_API;
    else process.env.OPENSESAME_HOST_API = originalHost;
  });

  it("does not project the private frozen intent into model output or context", async () => {
    setTaskContext({ taskRunId: "t-1", stateVersion: 1 });
    setFetchForTests(
      async () =>
        new Response(
          JSON.stringify({
            intent_id: "i-1",
            intent_digest: "sha256:abc",
            task_state_version: 1,
            canonical_arguments: {},
            receipt_id: "receipt:018fbd8a-1e78-7a3c-9c24-1ebd832b8dcb",
            intent: { nonce: "private-frozen-nonce" },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
    );
    const result = resultSchema.parse(
      await freezeHandler()({
        operation: "read",
        resource: "r1",
        audience: "https://api.example.test",
        arguments: {},
      }),
    );
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result)).not.toContain("private-frozen-nonce");
    expect(JSON.stringify(getTaskContext())).not.toContain(
      "private-frozen-nonce",
    );
    expect(getTaskContext()?.frozenIntent?.reservedReceiptId).toBe(
      "receipt:018fbd8a-1e78-7a3c-9c24-1ebd832b8dcb",
    );
  });

  it("keeps pending recovery across a successful freeze and drops a non-uuid receipt id", async () => {
    setTaskContext({
      taskRunId: "t-1",
      stateVersion: 1,
      pendingInvocationRecovery: {
        intentId: "i-old",
        intentDigest: "sha256:old",
        operation: "read",
        resource: "r1",
        audience: "https://api.example.test",
        reservedReceiptId: "018fbd8a-1e78-7a3c-9c24-1ebd832b8dcb",
      },
    });
    setFetchForTests(
      async () =>
        new Response(
          JSON.stringify({
            intent_id: "i-1",
            intent_digest: "sha256:abc",
            task_state_version: 2,
            canonical_arguments: {},
            receipt_id: "not-a-uuid",
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
    );
    const result = resultSchema.parse(
      await freezeHandler()({
        operation: "read",
        resource: "r1",
        audience: "https://api.example.test",
        arguments: {},
      }),
    );
    expect(result.isError).toBe(false);
    expect(getTaskContext()?.pendingInvocationRecovery).toMatchObject({
      intentId: "i-old",
      reservedReceiptId: "018fbd8a-1e78-7a3c-9c24-1ebd832b8dcb",
    });
    expect(getTaskContext()?.frozenIntent?.reservedReceiptId).toBeUndefined();
    expect(getTaskContext()?.frozenIntent?.intentId).toBe("i-1");
  });

  it("does not expose malformed frozen response bytes in an exception", async () => {
    setTaskContext({
      taskRunId: "t-1",
      stateVersion: 1,
      frozenIntent: {
        intentId: "old",
        intentDigest: "sha256:old",
        operation: "old",
        resource: "old",
        audience: "https://api.example.test",
        canonicalArguments: {},
      },
    });
    setFetchForTests(
      async () =>
        new Response('{"intent":{"nonce":"private-frozen-nonce"', {
          status: 200,
        }),
    );
    const result = resultSchema.parse(
      await freezeHandler()({
        operation: "read",
        resource: "r1",
        audience: "https://api.example.test",
        arguments: {},
      }),
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private-frozen-nonce");
    expect(getTaskContext()?.frozenIntent).toBeUndefined();
  });

  it("does not restore an old task after a delayed freeze response", async () => {
    setTaskContext({ taskRunId: "t-1", stateVersion: 1 });
    let release: (response: Response) => void = (_response) => {
      throw new Error("freeze was not sent");
    };
    let sent = false;
    setFetchForTests(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
          sent = true;
        }),
    );
    const pending = freezeHandler()({
      operation: "read",
      resource: "r1",
      audience: "https://api.example.test",
      arguments: {},
    });
    await vi.waitFor(() => expect(sent).toBe(true));
    setTaskContext({ taskRunId: "t-2", stateVersion: 2 });
    release(
      new Response(
        JSON.stringify({ intent_id: "i-1", intent_digest: "sha256:abc" }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
    const result = resultSchema.parse(await pending);
    expect(result.isError).toBe(true);
    expect(getTaskContext()).toEqual({ taskRunId: "t-2", stateVersion: 2 });
  });
});
