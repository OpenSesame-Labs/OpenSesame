import { expect, it, vi } from "vitest";
import {
  activateInteraction,
  enrolPasskey,
} from "./interaction-webauthn-fixture.js";
import { fixture, gate } from "./interaction-clock-fixture.js";

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function approveInteraction(f: Fixture): Promise<void> {
  await f.cp.app.request(`/v1/interactions/${f.ref}`, {
    headers: { authorization: `Bearer ${f.approver.accessToken}` },
  });
  const credentialId = await enrolPasskey(f.cp, f.approver.principalId);
  const activationId = await activateInteraction(
    f.cp,
    f.approver.accessToken,
    f.ref,
    f.requestDigest,
    credentialId,
  );
  const response = await f.cp.app.request(`/v1/interactions/${f.ref}/approve`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${f.approver.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      requestDigest: f.requestDigest,
      activationId,
    }),
  });
  expect(response.status).toBe(200);
}

it("rolls back consume when the interaction expires during reservation acquisition", async () => {
  const f = await fixture();
  await approveInteraction(f);
  const pause = gate();
  const repo = f.cp.ctx.repos.executionReservations;
  const acquire = repo.acquire.bind(repo);
  const spy = vi
    .spyOn(repo, "acquire")
    .mockImplementation(async (...args: Parameters<typeof acquire>) => {
      const result = await acquire(...args);
      pause.arrive();
      await pause.released;
      return result;
    });

  const pending = f.cp.app.request(`/v1/interactions/${f.ref}/consume`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${f.requester.accessToken}`,
    },
  });
  try {
    await pause.arrived;
    f.advance(300);
  } finally {
    pause.release();
  }
  const response = await pending;
  spy.mockRestore();

  expect(response.status).toBe(410);
  expect(await response.json()).toEqual({ error: "interaction_expired" });
  expect((await f.cp.ctx.repos.interactions.getById(f.id))?.status).toBe(
    "approved",
  );
});
