import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hostFetch } from "./host-api.js";
import {
  INVOCATION_RESPONSE_TIMEOUT_MS,
  readFreezeIntentResponse,
} from "./invocation-response.js";
import {
  clearFrozenIntent,
  getTaskContext,
  setTaskContext,
} from "./task-context.js";
import { agentJson, safeTokenSchema, textContent } from "./tools.js";

export function registerFreezeTool(server: McpServer): void {
  const intentResponseSchema = z.object({
    intent_id: safeTokenSchema,
    intent_digest: safeTokenSchema,
    task_run_id: safeTokenSchema.optional(),
    task_state_version: z.number().int().nonnegative().optional(),
    canonical_arguments: z.unknown().optional(),
  });
  const intentAgentResponseSchema = intentResponseSchema.omit({
    canonical_arguments: true,
  });
  server.tool(
    "task_invoke",
    "Freeze a task-bound intent (stores frozen intent in MCP task context)",
    {
      operation: z.string(),
      resource: z.string(),
      audience: z.string(),
      arguments: z.record(z.string(), z.unknown()).default({}),
      idempotency_key: z.string().optional(),
    },
    async ({
      operation,
      resource,
      audience,
      arguments: args,
      idempotency_key,
    }) => {
      const ctx = getTaskContext();
      if (!ctx?.taskRunId) {
        return {
          content: textContent("task_invoke_failed: task_context_required"),
          isError: true,
        };
      }
      // A failed replacement freeze must not leave the previous operation
      // available to a later task_invoke_l1 call.
      clearFrozenIntent();
      const freezeContext = getTaskContext();
      try {
        const res = await hostFetch("/api/v1/tasks/intents", {
          method: "POST",
          signal: AbortSignal.timeout(INVOCATION_RESPONSE_TIMEOUT_MS),
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            task_run_id: ctx.taskRunId,
            expected_state_version: ctx.stateVersion,
            operation,
            resource,
            audience,
            arguments: args,
            idempotency_key: idempotency_key ?? crypto.randomUUID(),
          }),
        });
        const body = await readFreezeIntentResponse(res);
        const intentResponse = intentResponseSchema.safeParse(body);
        if (!res.ok || !intentResponse.success)
          throw new Error("freeze_refused");
        const projected = agentJson(body, true, intentAgentResponseSchema);
        if (getTaskContext() !== freezeContext) throw new Error("task_changed");
        const receiptId =
          typeof body === "object" &&
          body !== null &&
          "receipt_id" in body &&
          typeof body.receipt_id === "string"
            ? body.receipt_id
            : undefined;
        setTaskContext({
          taskRunId: ctx.taskRunId,
          stateVersion:
            intentResponse.data.task_state_version ?? ctx.stateVersion,
          frozenIntent: {
            intentId: intentResponse.data.intent_id,
            intentDigest: intentResponse.data.intent_digest,
            operation,
            resource,
            audience,
            canonicalArguments: intentResponse.data.canonical_arguments ?? args,
            reservedReceiptId: receiptId,
          },
        });
        return {
          content: textContent(projected),
          isError: false,
        };
      } catch {
        // Neither malformed upstream bytes nor a secret frozen nonce belongs in
        // a model-visible exception. A failed freeze does not authorize invoke.
        return {
          content: textContent("task_invoke_failed: refused"),
          isError: true,
        };
      }
    },
  );
}
