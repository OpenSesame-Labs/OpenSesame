import {
  SCIM_GROUP_CHANGES_MAX,
  SCIM_GROUP_ID_MAX,
  SCIM_GROUP_MEMBERS_MAX,
  type ScimGroupRecord,
} from "@opensesame/database";
import type { JsonObject } from "@opensesame/os-domain";
import { isJsonObject } from "@opensesame/os-domain";
import {
  parseMemberSelector,
  resolveMemberIds,
} from "./scim-member-selector.js";
import { type ScimPatchOperation, boundedScimString } from "./scim-protocol.js";

/** Pure folding of a SCIM Group PatchOp onto the stored group (RFC 7644). */
const MAX_DISPLAY_LENGTH = 512;

function foldDisplayName(
  body: JsonObject,
  operations: ScimPatchOperation[],
  fallback: string,
): string {
  let displayName =
    boundedScimString(body.displayName, MAX_DISPLAY_LENGTH) ?? fallback;
  for (const operation of operations) {
    if (operation.path?.toLowerCase() !== "displayname") continue;
    if (operation.value === undefined) continue;
    displayName =
      boundedScimString(operation.value, MAX_DISPLAY_LENGTH) ?? displayName;
  }
  return displayName;
}

function targetsMembers(operation: ScimPatchOperation): boolean {
  if (operation.path !== undefined) {
    const path = operation.path.trim();
    return parseMemberSelector(path) !== undefined || /^members/i.test(path);
  }
  return isJsonObject(operation.value) && operation.value.members !== undefined;
}

export function foldGroupPatch(
  body: JsonObject,
  operations: ScimPatchOperation[],
  existing: ScimGroupRecord | null,
  groupId: string,
):
  | { displayName: string; memberIds: string[]; affected: string[] }
  | { error: { detail: string; scimType: string } } {
  let memberList = existing ? [...existing.memberIds] : [];
  const affected = new Set<string>();
  for (const operation of operations) {
    if (!targetsMembers(operation)) continue;
    const resolved = resolveMemberIds(operation);
    if ("error" in resolved) return resolved;
    // Over-long ids are admissible only as members the group already holds,
    // so legacy members can be removed but no new one can be added.
    if (
      resolved.ids.some(
        (id) => id.length > SCIM_GROUP_ID_MAX && !memberList.includes(id),
      )
    )
      return {
        error: { detail: "Invalid member id.", scimType: "invalidValue" },
      };
    const applied = applyMemberOp(memberList, operation.op, resolved.ids);
    if ("error" in applied) return applied;
    for (const id of resolved.ids) affected.add(id);
    if (affected.size > SCIM_GROUP_CHANGES_MAX)
      return {
        error: {
          detail: "Too many member changes in one request.",
          scimType: "tooMany",
        },
      };
    memberList = applied.memberIds;
  }
  if (
    memberList.length > SCIM_GROUP_MEMBERS_MAX &&
    memberList.length >= (existing?.memberIds.length ?? 0)
  )
    return {
      error: { detail: "Group member capacity reached.", scimType: "tooMany" },
    };
  return {
    displayName: foldDisplayName(
      body,
      operations,
      existing?.displayName ?? groupId,
    ),
    memberIds: memberList,
    affected: [...affected],
  };
}

function applyMemberOp(
  current: string[],
  op: string,
  ids: string[],
): { memberIds: string[] } | { error: { detail: string; scimType: string } } {
  if (op === "add") {
    const next = [...current];
    for (const id of ids) {
      if (!next.includes(id)) next.push(id);
    }
    return { memberIds: next };
  }
  if (op === "remove") {
    const drop = new Set(ids);
    return { memberIds: current.filter((id) => !drop.has(id)) };
  }
  return {
    error: {
      detail: "Bulk member replace is not supported.",
      scimType: "invalidValue",
    },
  };
}
