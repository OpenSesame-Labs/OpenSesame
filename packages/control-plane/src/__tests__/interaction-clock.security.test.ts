import { describe, expect, it, vi } from "vitest";
import { isLiveAt, requireLiveAt } from "../services/interaction-clock.js";
import {
  activateInteraction,
  enrolPasskey,
} from "./interaction-webauthn-fixture.js";
import { fixture, gate } from "./interaction-clock-fixture.js";

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function activate(f: Fixture) {
  await f.cp.app.request(`/v1/interactions/${f.ref}`, {
    headers: { authorization: `Bearer ${f.approver.accessToken}` },
  });
  const credentialId = await enrolPasskey(f.cp, f.approver.principalId);
  return activateInteraction(
    f.cp,
    f.approver.accessToken,
    f.ref,
    f.requestDigest,
    credentialId,
  );
}
function approve(f: Fixture, activationId: string) {
  return f.cp.app.request(`/v1/interactions/${f.ref}/approve`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${f.approver.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ requestDigest: f.requestDigest, activationId }),
  });
}
function consume(f: Fixture) {
  return f.cp.app.request(`/v1/interactions/${f.ref}/consume`, {
    method: "POST",
    headers: { authorization: `Bearer ${f.requester.accessToken}` },
  });
}

describe("interaction admission at the last application clock sample", () => {
  it("rejects invalid dates and expires at equality", () => {
    const deadline = new Date(1000);
    expect(isLiveAt(deadline, new Date(999))).toBe(true);
    expect(isLiveAt(deadline, new Date(1000))).toBe(false);
    expect(isLiveAt(deadline, new Date(1001))).toBe(false);
    expect(isLiveAt(deadline, new Date(Number.NaN))).toBe(false);
    expect(isLiveAt(new Date(Number.NaN), new Date(0))).toBe(false);
    expect(() => requireLiveAt(deadline, new Date(1000))).toThrow();
  });
  it.each([
    {
      label: "interaction",
      ttl: 300,
      error: "interaction_expired",
      status: 410,
    },
    {
      label: "activation only",
      ttl: 600,
      error: "proof_required",
      status: 401,
    },
  ])(
    "refuses when the $label expires during proof recording",
    async ({ ttl, error, status }) => {
      const f = await fixture(ttl);
      const activationId = await activate(f);
      const pause = gate();
      const repo = f.cp.ctx.repos.interactionProofAttempts;
      const record = repo.record.bind(repo);
      const spy = vi
        .spyOn(repo, "record")
        .mockImplementation(async (attempt) => {
          const result = await record(attempt);
          if (attempt.outcome === "accepted") {
            pause.arrive();
            await pause.released;
          }
          return result;
        });
      const pending = approve(f, activationId);
      try {
        await pause.arrived;
        f.advance(300);
      } finally {
        pause.release();
      }
      const response = await pending;
      spy.mockRestore();
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error });
      // A post-spend expiry check is not rollback.
      expect(
        (await f.cp.ctx.repos.approvalActivations.getById(activationId))?.state,
      ).toBe("consumed");
      expect(
        (await f.cp.ctx.repos.interactions.getById(f.id))?.status,
      ).not.toBe("approved");
    },
  );
  it("does not spend an activation after an interaction expires during lookup", async () => {
    const f = await fixture();
    const activationId = await activate(f);
    const pause = gate();
    const repo = f.cp.ctx.repos.approvalActivations;
    const getById = repo.getById.bind(repo);
    const spy = vi.spyOn(repo, "getById").mockImplementation(async (id) => {
      const result = await getById(id);
      if (id === activationId) {
        pause.arrive();
        await pause.released;
      }
      return result;
    });
    const pending = approve(f, activationId);
    try {
      await pause.arrived;
      f.advance(300);
    } finally {
      pause.release();
    }
    const response = await pending;
    spy.mockRestore();
    expect(response.status).toBe(410);
    expect((await getById(activationId))?.state).toBe("activated");
    expect((await f.cp.ctx.repos.interactions.getById(f.id))?.status).not.toBe(
      "approved",
    );
  });
  it("refuses consume if the interaction expires while the initial read is paused", async () => {
    const f = await fixture();
    const activationId = await activate(f);
    expect((await approve(f, activationId)).status).toBe(200);
    const pause = gate();
    const repo = f.cp.ctx.repos.interactions;
    const getById = repo.getById.bind(repo);
    const read = vi.spyOn(repo, "getById").mockImplementation(async (id) => {
      const result = await getById(id);
      if (id === f.id) {
        pause.arrive();
        await pause.released;
      }
      return result;
    });
    const pending = consume(f);
    try {
      await pause.arrived;
      f.advance(300);
    } finally {
      pause.release();
    }
    const response = await pending;
    read.mockRestore();
    expect(response.status).toBe(410);
    expect((await getById(f.id))?.status).toBe("approved");
  });
  it("still approves and consumes immediately before expiry", async () => {
    const f = await fixture();
    const activationId = await activate(f);
    f.advance(299);
    expect((await approve(f, activationId)).status).toBe(200);
    expect((await consume(f)).status).toBe(200);
  });
});
