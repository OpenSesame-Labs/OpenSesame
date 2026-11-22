import { overlapCast, resolveInteractionRef } from "@opensesame/os-domain";
import { expect } from "vitest";
import { createControlPlane } from "../create-app.js";
import { resetInteractionLinkBudget } from "../routes/interaction-handoff.js";
import {
  FACTORY_DELEGATION,
  factoryInboxRef,
  factoryPrincipal,
} from "./interaction-factory-helpers.js";
import { seedOwnedCeremony } from "./seed-ceremony-subject.js";

export function gate() {
  let arrive!: () => void;
  let release!: () => void;
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { arrive, arrived, release, released };
}

export async function fixture(ttlSeconds = 300) {
  let now = Date.parse("2026-08-31T12:00:00.000Z");
  resetInteractionLinkBudget();
  const cp = createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://127.0.0.1:8788",
      issuer: "http://127.0.0.1:8788",
    },
    clock: () => new Date(now),
  });
  const rawRequester = await factoryPrincipal(cp);
  const rawApprover = await factoryPrincipal(cp);
  const requester = {
    principalId: String(rawRequester.principalId),
    accessToken: String(rawRequester.accessToken),
  };
  const approver = {
    principalId: String(rawApprover.principalId),
    accessToken: String(rawApprover.accessToken),
  };
  const approverRef = await factoryInboxRef(cp, approver.accessToken);
  const subjectId = "clock-fence-device";
  seedOwnedCeremony(
    cp,
    "device_authorization",
    subjectId,
    requester.principalId,
  );
  const response = await cp.app.request("/v1/interactions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${requester.accessToken}`,
      "content-type": "application/json",
      "idempotency-key": "clock-fence",
    },
    body: JSON.stringify({
      kind: "device_authorization",
      subject: { kind: "device_authorization", subjectId },
      approverRef,
      authorizationDetails: [FACTORY_DELEGATION],
      ttlSeconds,
    }),
  });
  expect(response.status).toBe(201);
  const rawCreated = overlapCast(await response.json());
  const created = {
    ref: String(rawCreated.ref),
    requestDigest: String(rawCreated.requestDigest),
  };
  const id = resolveInteractionRef(
    created.ref,
    String(cp.ctx.config.claimPepper),
  );
  if (!id) throw new Error("fixture interaction reference was invalid");
  return {
    cp,
    requester,
    approver,
    ...created,
    id,
    advance: (seconds: number) => {
      now += seconds * 1000;
    },
  };
}
