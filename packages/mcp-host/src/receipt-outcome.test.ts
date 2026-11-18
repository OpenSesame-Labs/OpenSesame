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

function invokeHandler(): Handler {
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
  const handler = handlers.get("task_invoke_l1");
  if (!handler) throw new Error("task_invoke_l1_not_registered");
  return handler;
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
              receipt_schema_version: 5,
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

  it("projects a legacy receipt without exposing transformed provider data", async () => {
    const id = "018fbd8a-1e78-7a3c-9c24-1ebd832b8dcb";
    setFetchForTests(
      async () =>
        new Response(
          JSON.stringify({
            id,
            outcome: "succeeded",
            receipt_schema_version: 3,
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
  });

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
