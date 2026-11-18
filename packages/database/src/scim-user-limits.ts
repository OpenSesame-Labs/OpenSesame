/** Hard bounds on retained, tenant-provisioned users. Inactive users count:
 * deleting one is a deprovisioning signal, not permission to forget it. */
export const SCIM_USERS_PER_ORGANIZATION = 10_000;
export const SCIM_USERS_PER_DEPLOYMENT = 100_000;
export const SCIM_USER_RAW_MAX_BYTES = 32_768;
export const SCIM_USER_RAW_MAX_DEPTH = 32;
export const SCIM_USER_RAW_MAX_NODES = 4_096;
export const SCIM_PAGE_MAX = 100;

export interface ScimUserLimits {
  perOrganization: number;
  perDeployment: number;
}

export class ScimUserCapacityError extends Error {
  override readonly name = "ScimUserCapacityError";
  constructor() {
    super("SCIM user capacity reached");
  }
}

export class ScimUserPayloadError extends Error {
  override readonly name = "ScimUserPayloadError";
  constructor() {
    super("SCIM user attributes exceed the storage limit");
  }
}

export function validateScimRaw(raw: JsonObject): void {
  const pending: Array<{ value: JsonValue; depth: number }> = [
    { value: raw, depth: 0 },
  ];
  const seen = new Set<object>();
  let nodes = 0;
  while (pending.length) {
    const entry = pending.pop();
    if (!entry) break;
    if (
      ++nodes > SCIM_USER_RAW_MAX_NODES ||
      entry.depth > SCIM_USER_RAW_MAX_DEPTH
    )
      throw new ScimUserPayloadError();
    if (!Array.isArray(entry.value) && !isJsonObject(entry.value)) continue;
    if (seen.has(entry.value)) throw new ScimUserPayloadError();
    seen.add(entry.value);
    const children = Array.isArray(entry.value)
      ? entry.value
      : Object.values(entry.value);
    if (nodes + pending.length + children.length > SCIM_USER_RAW_MAX_NODES)
      throw new ScimUserPayloadError();
    for (const value of children)
      if (value !== undefined) pending.push({ value, depth: entry.depth + 1 });
  }
  if (Buffer.byteLength(JSON.stringify(raw), "utf8") > SCIM_USER_RAW_MAX_BYTES)
    throw new ScimUserPayloadError();
}

export function validateScimPage(page: ScimUserPageRequest): void {
  if (
    !Number.isSafeInteger(page.startIndex) ||
    page.startIndex < 1 ||
    !Number.isSafeInteger(page.count) ||
    page.count < 0 ||
    page.count > SCIM_PAGE_MAX
  )
    throw new Error("Invalid SCIM page");
}

/** Factories can lower the hard ceiling, for smaller deployments and tests. */
export function scimUserLimits(
  limits?: Partial<ScimUserLimits>,
): ScimUserLimits {
  const perOrganization =
    limits?.perOrganization ?? SCIM_USERS_PER_ORGANIZATION;
  const perDeployment = limits?.perDeployment ?? SCIM_USERS_PER_DEPLOYMENT;
  if (
    !Number.isSafeInteger(perOrganization) ||
    perOrganization < 1 ||
    perOrganization > SCIM_USERS_PER_ORGANIZATION ||
    !Number.isSafeInteger(perDeployment) ||
    perDeployment < 1 ||
    perDeployment > SCIM_USERS_PER_DEPLOYMENT
  )
    throw new Error("Invalid SCIM user limits");
  return { perOrganization, perDeployment };
}

import {
  type JsonObject,
  type JsonValue,
  isJsonObject,
} from "@opensesame/os-domain";
import type { ScimUserPageRequest } from "./scim-store.js";
