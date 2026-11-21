import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { forAgent } from "./agent-payload.js";
import { hostFetch } from "./host-api.js";
import {
  INVOCATION_RESPONSE_TIMEOUT_MS,
  readFreezeIntentResponse,
} from "./invocation-response.js";
import { projectInvocationResponse } from "./receipt-outcome.js";
import {
  clearFrozenIntent,
  noteReservedReceiptId,
  recordPendingInvocationRecovery,
  requireFrozenIntent,
  requireTaskRunId,
} from "./task-context.js";

function textContent(text: string) {
  return [{ type: "text" as const, text }];
}

export function registerInvokeTool(server: McpServer): void {
  server.tool(
    "task_invoke_l1",
    "Execute the frozen task intent with the scoped agent capability; no operator authority",
    {},
    async () => {
      let dispatched = false;
      try {
        const taskRunId = requireTaskRunId();
        const intent = requireFrozenIntent();
        // Once dispatch begins, a transport failure cannot prove whether an
        // external effect occurred. Never retain it for an automatic retry.
        recordPendingInvocationRecovery(intent);
        clearFrozenIntent();
        dispatched = true;
        // Operation, resource, and arguments are whatever was frozen: letting the
        // model restate them here would execute one call while presenting another
        // call's digest.
        const res = await hostFetch("/api/v1/tasks/invoke", {
          method: "POST",
          signal: AbortSignal.timeout(INVOCATION_RESPONSE_TIMEOUT_MS),
          headers: {
            "content-type": "application/json",
            "x-opensesame-task-run-id": taskRunId,
            "x-opensesame-intent-digest": intent.intentDigest,
          },
          body: JSON.stringify({
            intent_digest: intent.intentDigest,
          }),
        });
        const body = await readFreezeIntentResponse(res);
        const projected = projectInvocationResponse(res.ok, body);
        if (projected.id !== undefined) {
          noteReservedReceiptId(taskRunId, projected.id);
        }
        return {
          content: textContent(forAgent(JSON.stringify(projected))),
          isError: projected.outcome !== "succeeded",
        };
      } catch (e) {
        if (
          !dispatched &&
          e instanceof Error &&
          ["task_context_required", "frozen_intent_required"].includes(
            e.message,
          )
        )
          return {
            content: textContent(`operator_invoke_failed: ${e.message}`),
            isError: true,
          };
        return {
          content: textContent('{"outcome":"indeterminate"}'),
          isError: true,
        };
      }
    },
  );
}
