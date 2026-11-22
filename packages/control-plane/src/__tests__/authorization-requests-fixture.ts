import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { expect } from "vitest";
import { createControlPlane } from "../create-app.js";

export type App = ReturnType<typeof createControlPlane>["app"];

export function plane(clock?: () => Date): App {
  return createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://127.0.0.1:8788",
      issuer: "http://127.0.0.1:8788",
    },
    ...(clock ? { clock } : undefined),
  }).app;
}

/**
 * The approver's inbox handle.
 *
 * Only its owner can obtain it, which is the point: a raw principal id is not
 * an address, so a caller who merely knows who someone is cannot reach them.
 */
export async function inboxRefOf(
  app: App,
  who: { accessToken: string },
): Promise<string> {
  const res = await app.request("/v1/authorization-requests/inbox-ref", {
    headers: { authorization: `Bearer ${who.accessToken}` },
  });
  expect(res.status).toBe(200);
  const body: { approverRef: string } = overlapCast(await res.json());
  return body.approverRef;
}

export async function principal(app: App) {
  const res = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(res.status).toBe(201);
  return overlapCast(await res.json());
}

let seq = 0;
export async function ask(
  app: App,
  requesterToken: string,
  approverRef: string,
  overrides: JsonObject = {},
) {
  const res = await app.request("/v1/authorization-requests", {
    method: "POST",
    headers: {
      authorization: `Bearer ${requesterToken}`,
      "content-type": "application/json",
      "idempotency-key": `ask-${++seq}`,
    },
    body: JSON.stringify({
      approverRef,
      bindingMessage: "Read acme/catalog issues",
      authorizationDetails: [
        {
          type: "connection_delegation",
          actions: ["repository.read"],
          locations: ["repo:acme/catalog"],
        },
      ],
      ...overrides,
    }),
  });
  return res;
}

export const decide = (
  app: App,
  token: string,
  id: string,
  action: "approve" | "deny",
  digest: string,
) =>
  app.request(`/v1/authorization-requests/${id}/${action}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ requestDigest: digest }),
  });
