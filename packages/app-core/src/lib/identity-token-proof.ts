import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { identityPlaneRequest } from "./device-identity.js";
import { IdentityError } from "./identity-session-types.js";

/** Identity-plane response helpers, split out of identity.ts. */

export async function readError(res: Response): Promise<string> {
  try {
    const body: JsonObject = overlapCast(await res.json());
    if (isString(body.message)) return body.message;
    if (isString(body.error)) return body.error;
    return `Request failed (${res.status}).`;
  } catch {
    return `Request failed (${res.status}).`;
  }
}

/** Prove a token with the cookie withheld; returns its principal. */
export async function proveTokenOwner(
  token: string,
  timeoutMs: number,
): Promise<string> {
  const res = await identityPlaneRequest("/v1/principals/me", {
    headers: { authorization: `Bearer ${token}` },
    credentials: "omit",
    timeoutMs,
  });
  if (!res.ok) throw new IdentityError(await readError(res), res.status);
  const me: BoundaryValue = await res.json();
  if (!isJsonObject(me) || !isString(me.id)) {
    throw new IdentityError("Identity returned an invalid principal.", 502);
  }
  return me.id;
}
