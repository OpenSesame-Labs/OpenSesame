import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import {
  identityPlaneRequest,
  resolveIdentityBase,
} from "./device-identity.js";
import {
  IdentityError,
  type IdentitySession,
} from "./identity-session-types.js";

/** Identity-plane response helpers, split out of identity.ts. */

const pendingRevokes = new Map<string, Set<string>>();
let pendingRevoke: Promise<void> | null = null;

export function queueIdentityRevoke(action: () => Promise<void>): void {
  pendingRevoke = (pendingRevoke ?? Promise.resolve()).then(action);
}

/** Wait for all queued revocations, including new ones added while waiting. */
export async function settleRevokes(): Promise<void> {
  while (pendingRevoke) {
    const inFlight = pendingRevoke;
    await inFlight;
    if (pendingRevoke === inFlight) pendingRevoke = null;
  }
}

export function rememberBearerRevoke(token: string, base: string): void {
  const tokens = pendingRevokes.get(base) ?? new Set<string>();
  tokens.add(token);
  pendingRevokes.set(base, tokens);
}

export function rememberForeignSession(
  session: IdentitySession | null,
  currentBase: string,
): void {
  if (
    session &&
    !session.cookieOnly &&
    session.issuerBase &&
    session.issuerBase !== currentBase
  )
    rememberBearerRevoke(session.accessToken, session.issuerBase);
}

export function bearerForIssuer(
  session: IdentitySession | null,
  base: string,
  origin: string,
): string | undefined {
  return session &&
    !session.cookieOnly &&
    session.issuerOrigin === origin &&
    (!session.issuerBase || session.issuerBase === base)
    ? session.accessToken
    : undefined;
}

export function hasPendingBearerRevokes(base: string): boolean {
  return (pendingRevokes.get(base)?.size ?? 0) > 0;
}

export function requireIssuer(base: string, token?: string): void {
  if (resolveIdentityBase() === base) return;
  if (token) rememberBearerRevoke(token, base);
  throw new IdentityError("The sign-in service changed. Try again.", 409);
}

export function revokeIdentityRequest(
  bearer?: string,
  credentials: RequestCredentials = "include",
  base = resolveIdentityBase(),
): Promise<Response> {
  if (resolveIdentityBase() !== base)
    throw new IdentityError("The sign-in service changed. Try again.", 409);
  return identityPlaneRequest("/v1/principals/provisional/revoke", {
    method: "POST",
    credentials,
    timeoutMs: 8000,
    ...(bearer
      ? { headers: { authorization: `Bearer ${bearer}` } }
      : undefined),
  });
}

export async function flushBearerRevokes(base: string): Promise<boolean> {
  if (resolveIdentityBase() !== base) return false;
  for (const token of pendingRevokes.get(base) ?? []) {
    try {
      const response = await revokeIdentityRequest(token, "omit", base);
      if (resolveIdentityBase() !== base || !response.ok) return false;
      pendingRevokes.get(base)?.delete(token);
    } catch {
      return false;
    }
  }
  if (!hasPendingBearerRevokes(base)) pendingRevokes.delete(base);
  return true;
}

export async function retryBearerRevokes(base: string): Promise<boolean> {
  if (!hasPendingBearerRevokes(base)) return true;
  queueIdentityRevoke(async () => {
    await flushBearerRevokes(base);
  });
  await settleRevokes();
  requireIssuer(base);
  return !hasPendingBearerRevokes(base);
}

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

export async function readIdentityJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new IdentityError(await readError(res), res.status);
  return overlapCast(await res.json());
}

/** Validate the provisional credential before it can enter session state. */
async function readProvisionalSession(
  res: Response,
): Promise<Pick<IdentitySession, "principalId" | "accessToken" | "expiresAt">> {
  if (!res.ok) throw new IdentityError(await readError(res), res.status);
  const body: JsonObject = overlapCast(await res.json());
  if (
    !isString(body.principalId) ||
    !isString(body.accessToken) ||
    (body.expiresAt !== undefined && !isString(body.expiresAt))
  ) {
    throw new IdentityError(
      "Identity returned an invalid provisional session.",
      502,
    );
  }
  return {
    principalId: body.principalId,
    accessToken: body.accessToken,
    expiresAt: body.expiresAt,
  };
}

export async function mintProvisionalCredential(
  freshGuest: boolean,
  issuerBase: string,
): Promise<Pick<IdentitySession, "principalId" | "accessToken" | "expiresAt">> {
  const res = await identityPlaneRequest("/v1/principals/provisional", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(freshGuest ? { "x-opensesame-fresh-guest": "1" } : undefined),
    },
    credentials: freshGuest ? "omit" : "include",
    body: "{}",
    timeoutMs: 8000,
  });
  const body = await readProvisionalSession(res);
  requireIssuer(issuerBase, body.accessToken);
  return body;
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
