import type { BoundaryValue, JsonObject } from "@opensesame/os-domain";
import {
  isBoolean,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import type { Context } from "hono";
import type { Variables } from "../middleware/context.js";

const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
const SCIM_CONTENT_TYPE = "application/scim+json";
type ScimStatus = 400 | 401 | 403 | 404 | 409;

export function scimBody(
  c: Context<{ Variables: Variables }>,
  status: ScimStatus | 200 | 201,
  payload: JsonObject,
): Response {
  return c.body(JSON.stringify(payload), status, {
    "content-type": SCIM_CONTENT_TYPE,
  });
}

/**
 * A SCIM-shaped error. Directory clients parse this envelope; a bare
 * `{ error: ... }` is reported by Okta as an unknown failure with no detail.
 */
export function scimError(
  c: Context<{ Variables: Variables }>,
  status: ScimStatus,
  detail: string,
  scimType?: string,
): Response {
  return scimBody(c, status, {
    schemas: [ERROR_SCHEMA],
    ...(scimType !== undefined ? { scimType } : undefined),
    detail,
    status: String(status),
  });
}

export function scimAuditActor(c: Context<{ Variables: Variables }>): {
  actorType: "human" | "system";
  actorId: string;
  principalId?: string;
} {
  const principalId = c.get("principalId");
  const provisioningToken = (c.req.header("authorization") ?? "")
    .toLowerCase()
    .startsWith("bearer sct_");
  return principalId && !provisioningToken
    ? { actorType: "human", actorId: principalId, principalId }
    : { actorType: "system", actorId: "scim" };
}

export function scimUserUpdateAudit(wasActive: boolean, active: boolean) {
  const deactivated = wasActive && !active;
  return {
    eventType: deactivated
      ? "organization.scim_user_deactivated"
      : "organization.scim_user_updated",
    metadata: {
      action: deactivated
        ? "organization.scim_user.deactivate"
        : "organization.scim_user.update",
      state: active ? "active" : "inactive",
    },
  };
}

export type ScimPatchOperation = {
  op: string;
  path?: string;
  value?: BoundaryValue;
};

export function scimPatchOperations(body: JsonObject): ScimPatchOperation[] {
  const raw = body.Operations ?? body.operations;
  if (!Array.isArray(raw)) return [];
  const operations: ScimPatchOperation[] = [];
  for (const entry of raw) {
    if (!isJsonObject(entry)) continue;
    const op = isString(entry.op) ? entry.op.toLowerCase() : "";
    if (!op) continue;
    operations.push({
      op,
      ...(isString(entry.path) ? { path: entry.path } : undefined),
      ...(entry.value !== undefined ? { value: entry.value } : undefined),
    });
  }
  return operations;
}

export async function readScimJsonBody(
  c: Context<{ Variables: Variables }>,
): Promise<JsonObject | undefined> {
  try {
    const parsed: BoundaryValue = overlapCast(await c.req.json());
    return isJsonObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function boundedScimString(
  value: BoundaryValue,
  max: number,
): string | undefined {
  if (!isString(value)) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return undefined;
  return trimmed;
}

/** Accept the boolean forms emitted by both Okta and Entra. */
export function scimActive(value: BoundaryValue): boolean | undefined {
  if (isBoolean(value)) return value;
  if (!isString(value)) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

/** Parse the one filter required by SCIM directory clients. */
export function scimUserNameFilter(filter: string): string | undefined {
  const match = filter
    .trim()
    .match(/^userName\s+eq\s+(?:"([^"]*)"|'([^']*)')$/i);
  return match?.[1] ?? match?.[2];
}

export type ScimPage = { startIndex: number; offset: number; limit: number };

function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^[1-9][0-9]*$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function nonNegativeInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(value))
    return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** Parse and cap SCIM's one-based pagination contract. */
export function scimPage(
  rawStart: string | undefined,
  rawCount: string | undefined,
): ScimPage | undefined {
  const parsedStart = positiveInteger(rawStart);
  const parsedCount = nonNegativeInteger(rawCount);
  if (
    (rawStart !== undefined && parsedStart === undefined) ||
    (rawCount !== undefined && parsedCount === undefined)
  ) {
    return undefined;
  }
  const startIndex = parsedStart ?? 1;
  return {
    startIndex,
    offset: startIndex - 1,
    limit: Math.min(parsedCount ?? 100, 200),
  };
}
