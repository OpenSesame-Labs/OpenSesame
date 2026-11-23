import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { JsonObject } from "@opensesame/os-domain";
import { z } from "zod";
import { hostFetch } from "./host-api.js";
import {
  INVOCATION_RESPONSE_TIMEOUT_MS,
  readFreezeIntentResponse,
} from "./invocation-response.js";
import { isHostReceiptId } from "./receipt-outcome.js";
import {
  type FrozenIntentContext,
  type TaskContext,
  clearFrozenIntent,
  getTaskContext,
  setTaskContext,
} from "./task-context.js";
import { agentJson, safeTokenSchema, textContent } from "./tools.js";

/**
 * Built lazily: `tools.ts` imports this module while its own exports are
 * still initializing, so touching `safeTokenSchema` at module scope would
 * read a not-yet-defined binding.
 */
function intentResponseSchema() {
  return z.object({
    intent_id: safeTokenSchema,
    intent_digest: safeTokenSchema,
    task_run_id: safeTokenSchema.optional(),
    task_state_version: z.number().int().nonnegative().optional(),
    canonical_arguments: z.unknown().optional(),
    receipt_id: z.string().optional(),
  });
}

function intentAgentResponseSchema() {
  return intentResponseSchema().omit({
    canonical_arguments: true,
    receipt_id: true,
  });
}

type TaskInvokeArgs = {
  operation: string;
  resource: string;
  audience: string;
  arguments: JsonObject;
  idempotency_key?: string | undefined;
};

async function taskInvoke({
  operation,
  resource,
  audience,
  arguments: args,
  idempotency_key,
}: TaskInvokeArgs) {
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
    const intentResponse = intentResponseSchema().safeParse(body);
    if (!res.ok || !intentResponse.success) throw new Error("freeze_refused");
    const projected = agentJson(body, true, intentAgentResponseSchema());
    if (getTaskContext() !== freezeContext) throw new Error("task_changed");
    const parsedReceiptId = intentResponse.data.receipt_id;
    const preserved =
      freezeContext?.taskRunId === ctx.taskRunId
        ? freezeContext.pendingInvocationRecovery
        : undefined;
    const frozenIntent: FrozenIntentContext = {
      intentId: intentResponse.data.intent_id,
      intentDigest: intentResponse.data.intent_digest,
      operation,
      resource,
      audience,
      canonicalArguments: intentResponse.data.canonical_arguments ?? args,
    };
    if (parsedReceiptId !== undefined && isHostReceiptId(parsedReceiptId)) {
      frozenIntent.reservedReceiptId = parsedReceiptId;
    }
    const next: TaskContext = {
      taskRunId: ctx.taskRunId,
      stateVersion: intentResponse.data.task_state_version ?? ctx.stateVersion,
      frozenIntent,
    };
    if (preserved !== undefined) {
      next.pendingInvocationRecovery = preserved;
    }
    setTaskContext(next);
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
}

export function registerFreezeTool(server: McpServer): void {
  server.tool(
    "task_invoke",
    "Freeze a task-bound intent (stores frozen intent in MCP task context)",
    {
      operation: z.string(),
      resource: z.string(),
      audience: z.string(),
      arguments: z.record(z.string(), z.json()).default({}),
      idempotency_key: z.string().optional(),
    },
    async (args) => taskInvoke(args),
  );
}
