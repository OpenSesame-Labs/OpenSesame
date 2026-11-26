import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { expect } from "vitest";
import McpHostStructuralProvider, { type RedteamVars } from "./mcp-provider.js";

type ToolResponse = {
  isError?: boolean;
  content?: unknown;
};

export type Probe = {
  bootstrapExchanges?: number;
  calls: Array<{
    tool: string;
    params: JsonObject;
    response: ToolResponse;
  }>;
  tools?: Array<{
    name: string;
    inputSchema: { properties?: JsonObject };
  }>;
  upstreamRequests?: Array<{
    url: string;
    body: string;
    headers: Record<string, string | string[] | undefined>;
  }>;
};

export async function probe(vars: RedteamVars): Promise<Probe> {
  const provider = new McpHostStructuralProvider();
  const result = await provider.callApi("", {
    vars: overlapCast(vars),
  });
  if (result.error) throw new Error(result.error);
  if (!result.output) throw new Error("empty structural probe output");
  return overlapCast(JSON.parse(result.output));
}

export function dump(data: Probe): string {
  return JSON.stringify(data);
}

export function assertTraversal(data: Probe): void {
  expect(data.calls[1]?.response.isError).toBe(true);
  expect(data.calls[1]?.response.content).toEqual([
    { type: "text", text: "task_invoke_failed: refused" },
  ]);
  expect(JSON.stringify(data.calls[1]?.response)).not.toContain(
    "capability_not_in_ceiling",
  );
  const requests = data.upstreamRequests ?? [];
  const intents = requests.filter((req) => req.url === "/api/v1/tasks/intents");
  expect(intents).toHaveLength(1);
  const body = overlapCast(JSON.parse(intents[0]?.body ?? "{}"));
  expect(body.resource).toBe("../other-org/secret");
  expect(
    requests.filter((req) => req.url === "/api/v1/tasks/invoke"),
  ).toHaveLength(0);
}
