import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type BoundaryValue,
  isFunction,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { mockAgentHeaders } from "./agent-headers-fixture.js";
import { resetFetchForTests, setFetchForTests } from "./host-api.js";
import { getTaskContext, setTaskContext } from "./task-context.js";
import { registerHostTools } from "./tools.js";

type Handler = (
  ...args: BoundaryValue[]
) => BoundaryValue | Promise<BoundaryValue>;

const resultSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string() })),
  isError: z.boolean(),
});

function toolHandler(name: string): Handler {
  const handlers = new Map<string, Handler>();
  const server = {
    tool: (...args: BoundaryValue[]) => {
      const name = args[0];
      const callback = args[args.length - 1];
      if (!isString(name) || !isFunction(callback)) {
        throw new Error("invalid_test_tool_registration");
      }
      const handler: Handler = overlapCast(callback);
      handlers.set(name, handler);
    },
  };
  const typedServer: McpServer = overlapCast(server);
  registerHostTools(typedServer);
  const handler = handlers.get(name);
  if (!handler) throw new Error("requested_tool_not_registered");
  return handler;
}

function invokeHandler(): Handler {
  return toolHandler("task_invoke_l1");
}

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
      await toolHandler("task_invoke")({
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
      await toolHandler("task_invoke")({
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
    const pending = toolHandler("task_invoke")({
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
  });
});
