import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockAgentHeaders } from "./agent-headers-fixture.js";
import { resetFetchForTests, setFetchForTests } from "./host-api.js";
import { projectInvocationResponse } from "./receipt-outcome.js";
import { invokeHandler, resultSchema } from "./receipt-outcome-fixture.js";
import { getTaskContext, setTaskContext } from "./task-context.js";

describe("projectInvocationResponse", () => {
  it.each(["failed", "denied", "cancelled"] as const)(
    "refuses terminal %s without a receipt id",
    (outcome) => {
      expect(
        projectInvocationResponse(true, {
          outcome,
          receipt_schema_version: 6,
        }),
      ).toEqual({ outcome: "indeterminate" });
    },
  );
});

describe("task_invoke_l1 receipt outcomes", () => {
  const originalHost = process.env.OPENSESAME_HOST_API;

  beforeEach(() => {
    process.env.OPENSESAME_HOST_API = "http://127.0.0.1:8787";
    mockAgentHeaders();
    setTaskContext({
      taskRunId: "t-1",
      stateVersion: 1,
      frozenIntent: {
        intentId: "i-1",
        intentDigest: "sha256:abc",
        operation: "read",
        resource: "r1",
        audience: "https://api.example.test",
        canonicalArguments: {},
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetFetchForTests();
    setTaskContext(null);
    if (originalHost === undefined) delete process.env.OPENSESAME_HOST_API;
    else process.env.OPENSESAME_HOST_API = originalHost;
  });

  it("preserves recovery material after uncertain delivery", async () => {
    setFetchForTests(async () => new Response("not json", { status: 502 }));
    const result = resultSchema.parse(await invokeHandler()({}));
    expect(result.isError).toBe(true);
    expect(getTaskContext()?.pendingInvocationRecovery).toMatchObject({
      intentId: "i-1",
      intentDigest: "sha256:abc",
      operation: "read",
      resource: "r1",
    });
    expect(getTaskContext()?.frozenIntent).toBeUndefined();
  });

  it("refuses success without a receipt id", async () => {
    setFetchForTests(
      async () =>
        new Response(
          JSON.stringify({ outcome: "succeeded", receipt_schema_version: 6 }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    const result = resultSchema.parse(await invokeHandler()({}));
    expect(result.isError).toBe(true);
  });

  it.each([
    { outcome: "succeeded", status: 200, isError: false },
    { outcome: "failed", status: 200, isError: true },
    { outcome: "denied", status: 200, isError: true },
    { outcome: "cancelled", status: 200, isError: true },
    { outcome: "unknown", status: 200, isError: true },
    { outcome: undefined, status: 200, isError: true },
    { outcome: "succeeded", status: 500, isError: true },
  ])(
    "reports $outcome over HTTP $status",
    async ({ outcome, status, isError }) => {
      setFetchForTests(
        async () =>
          new Response(
            JSON.stringify({
              id: "018fbd8a-1e78-7a3c-9c24-1ebd832b8dcb",
              outcome,
              receipt_schema_version: 6,
            }),
            {
              status,
              headers: { "content-type": "application/json" },
            },
          ),
      );
      const result = resultSchema.parse(await invokeHandler()({}));
      expect(result.isError).toBe(isError);
      expect(getTaskContext()?.frozenIntent).toBeUndefined();
    },
  );

  it("refuses a success claim mixed with a materialization denial", async () => {
    setFetchForTests(
      async () =>
        new Response(
          JSON.stringify({ outcome: "succeeded", error: "materialize_denied" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    const result = resultSchema.parse(await invokeHandler()({}));
    expect(result.isError).toBe(true);
  });

  it.each([3, 5])(
    "withholds legacy schema %i provider data",
    async (version) => {
      const id = "018fbd8a-1e78-7a3c-9c24-1ebd832b8dcb";
      setFetchForTests(
        async () =>
          new Response(
            JSON.stringify({
              id,
              outcome: "succeeded",
              receipt_schema_version: version,
              safe_result_summary: { result: "1-ssecca-ecar" },
              external_request_digest: "1-ssecca-ecar",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      );
      const result = resultSchema.parse(await invokeHandler()({}));
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual({
        outcome: "indeterminate",
      });
    },
  );

  it("does not return free-form error details", async () => {
    setFetchForTests(
      async () =>
        new Response(
          JSON.stringify({
            error: "frozen_invoke_denied",
            detail: "1-ssecca-ecar",
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
    );
    const result = resultSchema.parse(await invokeHandler()({}));
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual({
      outcome: "indeterminate",
    });
  });

  it("keeps the private receipt opening out of model-visible output", async () => {
    const opening = `hmac-sha256:v1:${"a".repeat(64)}`;
    const privateIntent = "private-original-intent";
    setFetchForTests(
      async () =>
        new Response(
          JSON.stringify({
            id: "018fbd8a-1e78-7a3c-9c24-1ebd832b8dcb",
            outcome: "succeeded",
            receipt_schema_version: 6,
            intent_opening: {
              opening,
              intent_digest: "private-raw-digest",
              intent: { nonce: privateIntent },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const result = resultSchema.parse(await invokeHandler()({}));
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result)).not.toContain(opening);
    expect(JSON.stringify(result)).not.toContain(privateIntent);
    expect(JSON.stringify(result)).not.toContain("private-raw-digest");
  });

  it("does not return a malformed response body through a parser error", async () => {
    setFetchForTests(
      async () => new Response("1-ssecca-ecar is not JSON", { status: 200 }),
    );
    const result = resultSchema.parse(await invokeHandler()({}));
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).not.toContain("1-ssecca-ecar");
    expect(result.content[0]?.text).toContain("indeterminate");
    expect(getTaskContext()?.frozenIntent).toBeUndefined();
  });

  it("stores reserved receipt id on the task context after invoke", async () => {
    const id = "018fbd8a-1e78-7a3c-9c24-1ebd832b8dcb";
    setFetchForTests(
      async () =>
        new Response(
          JSON.stringify({
            id,
            outcome: "succeeded",
            receipt_schema_version: 6,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const result = resultSchema.parse(await invokeHandler()({}));
    expect(result.isError).toBe(false);
    expect(getTaskContext()?.pendingInvocationRecovery?.reservedReceiptId).toBe(
      id,
    );
    expect(result.isError).toBe(false);
  });

  it("refuses a malformed receipt id without claiming success", async () => {
    setFetchForTests(
      async () =>
        new Response(
          JSON.stringify({ id: "1-ssecca-ecar", outcome: "succeeded" }),
          {
            status: 200,
          },
        ),
    );
    const result = resultSchema.parse(await invokeHandler()({}));
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).not.toContain("1-ssecca-ecar");
    expect(result.content[0]?.text).toContain("indeterminate");
    expect(
      getTaskContext()?.pendingInvocationRecovery?.reservedReceiptId,
    ).toBeUndefined();
  });

  it("does not attach a late receipt id to a different task", async () => {
    let release: (response: Response) => void = () => {
      throw new Error("invoke was not sent");
    };
    let sent = false;
    setFetchForTests(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
          sent = true;
        }),
    );
    const pending = invokeHandler()({});
    await vi.waitFor(() => expect(sent).toBe(true));
    setTaskContext({ taskRunId: "t-2", stateVersion: 2 });
    release(
      new Response(
        JSON.stringify({
          id: "018fbd8a-1e78-7a3c-9c24-1ebd832b8dcb",
          outcome: "succeeded",
          receipt_schema_version: 6,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const result = resultSchema.parse(await pending);
    expect(result.isError).toBe(false);
    expect(getTaskContext()).toEqual({ taskRunId: "t-2", stateVersion: 2 });
  });
});
