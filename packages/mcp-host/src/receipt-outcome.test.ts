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
          new Response(JSON.stringify({ id: "receipt:1", outcome }), {
            status,
            headers: { "content-type": "application/json" },
          }),
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
});
