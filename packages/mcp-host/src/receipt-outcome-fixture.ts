import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type BoundaryValue,
  isFunction,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { z } from "zod";
import { registerHostTools } from "./tools.js";

export type Handler = (
  ...args: BoundaryValue[]
) => BoundaryValue | Promise<BoundaryValue>;

export const resultSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string() })),
  isError: z.boolean(),
});

export function toolHandler(name: string): Handler {
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

export function invokeHandler(): Handler {
  return toolHandler("task_invoke_l1");
}

export function freezeHandler(): Handler {
  return toolHandler("task_invoke");
}
