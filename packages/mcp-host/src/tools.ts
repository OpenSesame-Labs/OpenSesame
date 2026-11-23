import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { stringifyLosslessJson } from "@opensesame/api-client";
import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { z } from "zod";
import { forAgent } from "./agent-payload.js";
import { daemonFetch, hostFetch } from "./host-api.js";
import {
  getTaskContext,
  requireTaskRunId,
  setTaskContext,
  updateTaskFromResponse,
} from "./task-context.js";
import { registerActTools } from "./tools-act.js";
import { registerFreezeTool } from "./tools-freeze.js";
import { registerInvokeTool } from "./tools-invoke.js";
import { registerReadTools } from "./tools-read.js";

export const hostTools = [
  "task_start",
  "task_status",
  "task_invoke",
  "task_terminate",
  "daemon_health",
  "host_ready",
  "task_invoke_l1",
  "task_list",
  "sync_push",
  "sync_pull",
] as const;

export function assertsNoSecretTools(names: readonly string[]): void {
  if (
    names.some((n) =>
      /secret|materialize|pass_show|sealed_store_show|password_store_read|pepper|oprf|^show$/i.test(
        n,
      ),
    )
  ) {
    throw new Error("secret_tools_forbidden");
  }
}

const capabilitySchema = z.object({
  action: z.string(),
  resource: z.string(),
});

export const safeTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9:._/-]{1,512}$/, "invalid opaque identifier");

const taskStateResponseSchema = z.object({
  task_run_id: safeTokenSchema.optional(),
  state_version: z.number().int().nonnegative().optional(),
  state_digest: safeTokenSchema.optional(),
  ceiling_digest: safeTokenSchema.optional(),
  status: z
    .enum([
      "pending",
      "active",
      "restricting",
      "completed",
      "failed",
      "cancelled",
    ])
    .optional(),
  capabilities: z.array(capabilitySchema).max(64).optional(),
  capability_ceiling: z.array(capabilitySchema).max(64).optional(),
  current_capabilities: z.array(capabilitySchema).max(64).optional(),
  maximum_expires_at: z.string().datetime().optional(),
});

const daemonStatusResponseSchema = z.object({
  status: z.literal("ok"),
});

export const errorResponseSchema = z.object({ error: safeTokenSchema });

export function registerHostTools(server: McpServer): void {
  assertsNoSecretTools(hostTools);

  server.tool(
    "task_start",
    "Start a task with an immutable capability ceiling (Host API). Returns task_run_id for later invoke.",
    {
      principal_id: z.string(),
      organization_id: z.string(),
      // Bounds mirror the Host API's: a ceiling is a short list, and a task's
      // authority should not outlive the reason it was granted.
      capabilities: z.array(capabilitySchema).min(1).max(64),
      ttl_seconds: z.number().int().positive().max(86_400).optional(),
    },
    async ({ principal_id, organization_id, capabilities, ttl_seconds }) => {
      try {
        const res = await hostFetch("/api/v1/tasks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            principal_id,
            organization_id,
            capabilities,
            ttl_seconds: ttl_seconds ?? 3600,
          }),
        });
        const body = await res.json();
        const taskState = taskStateResponseSchema.safeParse(body);
        if (
          res.ok &&
          taskState.success &&
          taskState.data.task_run_id !== undefined &&
          taskState.data.state_version !== undefined
        ) {
          updateTaskFromResponse({
            task_run_id: taskState.data.task_run_id,
            state_version: taskState.data.state_version,
          });
        }
        return {
          content: textContent(
            agentJson(body, res.ok, taskStateResponseSchema),
          ),
          isError: !res.ok,
        };
      } catch (e) {
        return toolError(
          "task_start_failed",
          e instanceof Error ? e : String(e),
        );
      }
    },
  );

  server.tool(
    "task_status",
    "Show ceiling vs current capabilities for a task (defaults to active task context)",
    {
      task_run_id: z.string().optional(),
    },
    async ({ task_run_id }) => {
      try {
        const id = task_run_id ?? requireTaskRunId();
        const res = await hostFetch(`/api/v1/tasks/${encodeURIComponent(id)}`);
        const body = await res.json();
        const taskState = taskStateResponseSchema.safeParse(body);
        if (
          res.ok &&
          taskState.success &&
          taskState.data.task_run_id !== undefined &&
          taskState.data.state_version !== undefined
        ) {
          // A status read refreshes the active task; it does not switch to another.
          updateTaskFromResponse(
            {
              task_run_id: taskState.data.task_run_id,
              state_version: taskState.data.state_version,
            },
            { adopt: false },
          );
        }
        return {
          content: textContent(
            agentJson(body, res.ok, taskStateResponseSchema),
          ),
          isError: !res.ok,
        };
      } catch (e) {
        return toolError(
          "task_status_failed",
          e instanceof Error ? e : String(e),
        );
      }
    },
  );

  registerFreezeTool(server);

  server.tool(
    "task_terminate",
    "Terminate task run — no further capability assertions",
    {
      task_run_id: z.string().optional(),
      expected_state_version: z.number().int().optional(),
    },
    async ({ task_run_id, expected_state_version }) => {
      try {
        const id = task_run_id ?? requireTaskRunId();
        const ctx = getTaskContext();
        const res = await hostFetch(
          `/api/v1/tasks/${encodeURIComponent(id)}/terminate`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              expected_state_version:
                expected_state_version ?? ctx?.stateVersion ?? undefined,
            }),
          },
        );
        const body = await res.json();
        if (res.ok && ctx?.taskRunId === id) {
          setTaskContext(null);
        }
        return {
          content: textContent(
            agentJson(body, res.ok, taskStateResponseSchema),
          ),
          isError: !res.ok,
        };
      } catch (e) {
        return toolError(
          "task_terminate_failed",
          e instanceof Error ? e : String(e),
        );
      }
    },
  );

  server.tool("daemon_health", "Probe local host daemon", {}, async () => {
    try {
      const res = await daemonFetch("/health/live");
      const body = await res.json();
      const result = {
        content: textContent(
          agentJson(body, res.ok, daemonStatusResponseSchema),
        ),
      };
      if (!res.ok) return { ...result, isError: true };
      return result;
    } catch (e) {
      return toolError(
        "daemon_unavailable",
        e instanceof Error ? e : String(e),
      );
    }
  });

  server.tool("host_ready", "Host API readiness", {}, async () => {
    try {
      const res = await hostFetch("/health/ready");
      return {
        content: textContent(
          forAgent(
            JSON.stringify({
              status: res.status,
              ready: res.ok,
              tools: hostTools,
            }),
          ),
        ),
      };
    } catch (e) {
      return toolError("host_unavailable", e instanceof Error ? e : String(e));
    }
  });

  registerInvokeTool(server);

  registerReadTools(server);
  registerActTools(server);
}

export function textContent(text: string) {
  return [{ type: "text" as const, text }];
}

export function agentJson(
  body: BoundaryValue,
  ok: boolean,
  successSchema: z.ZodType,
) {
  // Refuse a compromised response containing credential-shaped material even
  // when that field is not part of the agent-visible allowlist. A freeze
  // response parsed losslessly can carry bigint canonical arguments, which
  // plain JSON.stringify refuses after the Host has already frozen the intent.
  forAgent(stringifyLosslessJson(body));
  const parsed = (ok ? successSchema : errorResponseSchema).safeParse(body);
  // SAFETY: zod output is the projection of a parsed JSON body.
  const projection: BoundaryValue = overlapCast(
    parsed.success ? parsed.data : { error: "upstream_response_invalid" },
  );
  return forAgent(stringifyLosslessJson(projection));
}

export function toolError(label: string, e: Error | string) {
  const message = e instanceof Error ? e.message : String(e);
  try {
    return {
      content: textContent(forAgent(`${label}: ${message}`)),
      isError: true,
    };
  } catch {
    return {
      content: textContent(`${label}: refused`),
      isError: true,
    };
  }
}

/**
 * Projection-first variant of agentJson, for the one route whose successful
 * body legitimately carries key material by design: cert issuance returns the
 * certificate and private key for out-of-band device delivery. Fencing the
 * raw body first (agentJson) would refuse every successful issuance, so this
 * projects through the allowlist first — which never includes the PEM fields
 * — and the credential fence then runs on the projection, so nothing
 * credential-shaped can survive into agent context either way.
 */
export function agentJsonProjected(
  body: BoundaryValue,
  ok: boolean,
  successSchema: z.ZodType,
) {
  const parsed = (ok ? successSchema : errorResponseSchema).safeParse(body);
  return forAgent(
    JSON.stringify(
      parsed.success ? parsed.data : { error: "upstream_response_invalid" },
    ),
  );
}
