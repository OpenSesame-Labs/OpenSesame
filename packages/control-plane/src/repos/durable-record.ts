import { deserialize, serialize } from "node:v8";
import { internalSecurityPrincipal } from "@opensesame/database";
import {
  type BoundaryValue,
  type JsonObject,
  isNumber,
  isString,
  isTypeofObject,
  overlapCast,
} from "@opensesame/os-domain";
import { ROW_ID_SCHEME } from "./durable-map-legacy.js";

/** Internal server-owned records only; never deserialize client-supplied bytes. */
export function decodeRecord<T>(payload: JsonObject): T {
  if (!isString(payload.value) || payload.value.length > 2_800_000)
    throw new Error("Invalid durable security record");
  return deserialize(Buffer.from(payload.value, "base64"));
}

/** The payload sealed for one record, tagged with the current row-id scheme. */
export function encodeRecord<T>(model: string, key: string, value: T) {
  const bytes = serialize(value);
  if (bytes.length > 2_000_000)
    throw new Error("Security record exceeds capacity");
  const record: BoundaryValue = overlapCast(value);
  const principalId = internalSecurityPrincipal(model, key, record);
  const payload: JsonObject = {
    value: bytes.toString("base64"),
    rowId: ROW_ID_SCHEME,
  };
  if (principalId) payload.accountId = principalId;
  return payload;
}

/** When a record stops being live: its own expiry, else the store TTL. */
export function recordExpiry<T>(
  model: string,
  ttlMs: number | null,
  value: T,
): Date | null {
  const record: BoundaryValue = overlapCast(value);
  // An expired session may still be the only durable evidence that its
  // revocation needs token and audit cleanup. Keep it until that succeeds.
  if (
    model === "OpenSesame:ProvisionalSession" &&
    isTypeofObject(record) &&
    record !== null &&
    "revocationCleanupPending" in record &&
    record.revocationCleanupPending === true
  )
    return null;
  const explicit =
    isTypeofObject(record) && record !== null && "expiresAt" in record
      ? record.expiresAt
      : undefined;
  if (explicit instanceof Date) return explicit;
  if (isNumber(explicit) && Number.isFinite(explicit))
    return new Date(explicit);
  return ttlMs === null ? null : new Date(Date.now() + ttlMs);
}
