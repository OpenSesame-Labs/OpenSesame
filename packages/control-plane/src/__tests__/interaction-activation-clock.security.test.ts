import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it, vi } from "vitest";
import { resetInteractionTotpBudget } from "../routes/interaction-activation-totp.js";
import { totpCode } from "../routes/mfa-totp.js";
import { fixture, gate } from "./interaction-clock-fixture.js";
import {
  assertionFor,
  beginInteractionActivation,
  completeInteractionActivation,
  enrolPasskey,
} from "./interaction-webauthn-fixture.js";
import { enrolTotp } from "./mfa-step-up-fixture.js";

describe("activation completion deadline admission", () => {
  it.each([
    { ttl: 300, error: "interaction_expired" },
    { ttl: 600, error: "activation_expired" },
  ])(
    "rejects WebAuthn completion after verification crosses the deadline ($error)",
    async ({ ttl, error }) => {
      const f = await fixture(ttl);
      const credential = await enrolPasskey(f.cp, f.approver.principalId);
      const begun = await beginInteractionActivation(
        f.cp,
        f.approver.accessToken,
        f.ref,
        f.requestDigest,
      );
      expect(begun.status).toBe(201);
      const pause = gate();
      const verifier = f.cp.ctx.hostAuthorizationPasskeys;
      const verify = verifier.verify.bind(verifier);
      const spy = vi
        .spyOn(verifier, "verify")
        .mockImplementation(async (input) => {
          const result = await verify(input);
          pause.arrive();
          await pause.released;
          return result;
        });
      const pending = completeInteractionActivation(
        f.cp,
        f.approver.accessToken,
        f.ref,
        begun.activationId,
        assertionFor(begun.challenge, credential),
      );
      try {
        await pause.arrived;
        f.advance(300);
      } finally {
        pause.release();
      }
      const response = await pending;
      spy.mockRestore();
      expect(response.status).toBe(410);
      expect(await response.json()).toEqual({ error });
      expect(
        (await f.cp.ctx.repos.approvalActivations.getById(begun.activationId))
          ?.state,
      ).toBe("pending");
    },
  );

  it("does not charge a WebAuthn attempt after expiry during challenge lookup", async () => {
    const f = await fixture(600);
    const credential = await enrolPasskey(f.cp, f.approver.principalId);
    const begun = await beginInteractionActivation(
      f.cp,
      f.approver.accessToken,
      f.ref,
      f.requestDigest,
    );
    expect(begun.status).toBe(201);
    const pause = gate();
    const challenges = f.cp.ctx.passkeyChallenges;
    const peek = challenges.peek.bind(challenges);
    const spy = vi
      .spyOn(challenges, "peek")
      .mockImplementation(async (challenge) => {
        const result = await peek(challenge);
        if (challenge === begun.challenge) {
          pause.arrive();
          await pause.released;
        }
        return result;
      });
    const pending = completeInteractionActivation(
      f.cp,
      f.approver.accessToken,
      f.ref,
      begun.activationId,
      assertionFor(begun.challenge, credential),
    );
    try {
      await pause.arrived;
      f.advance(300);
    } finally {
      pause.release();
    }
    const response = await pending;
    spy.mockRestore();
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: "activation_expired" });
    expect(
      (await f.cp.ctx.repos.approvalActivations.getById(begun.activationId))
        ?.state,
    ).toBe("pending");
    expect(
      await f.cp.ctx.stores.mfaFailures.get(
        `interaction-activation:${begun.activationId}`,
      ),
    ).toBeUndefined();
    expect(await peek(begun.challenge)).toBeDefined();
  });

  it("does not charge a TOTP attempt after expiry during activation lookup", async () => {
    resetInteractionTotpBudget();
    const f = await fixture(600);
    const secret = await enrolTotp(f.cp, f.approver.accessToken);
    const start = await f.cp.app.request(
      `/v1/interactions/${f.ref}/activation`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${f.approver.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          method: "totp",
          decision: "approved",
          requestDigest: f.requestDigest,
        }),
      },
    );
    expect(start.status).toBe(201);
    const begun = overlapCast<{ activationId: string }>(await start.json());
    const pause = gate();
    const repo = f.cp.ctx.repos.approvalActivations;
    const get = repo.getById.bind(repo);
    const spy = vi.spyOn(repo, "getById").mockImplementation(async (id) => {
      const result = await get(id);
      if (id === begun.activationId) {
        pause.arrive();
        await pause.released;
      }
      return result;
    });
    const pending = f.cp.app.request(
      `/v1/interactions/${f.ref}/activation/totp`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${f.approver.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          activationId: begun.activationId,
          code: totpCode(secret),
        }),
      },
    );
    try {
      await pause.arrived;
      f.advance(300);
    } finally {
      pause.release();
    }
    const response = await pending;
    spy.mockRestore();
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: "activation_expired" });
    expect((await get(begun.activationId))?.state).toBe("pending");
    expect(
      await f.cp.ctx.stores.mfaFailures.get(`totp:${f.approver.principalId}`),
    ).toBeUndefined();
    expect(
      await f.cp.ctx.stores.totpSteps.get(f.approver.principalId),
    ).toBeUndefined();
  });

  it("does not spend a TOTP code when the deadline passes during the account budget check", async () => {
    resetInteractionTotpBudget();
    const f = await fixture(600);
    const secret = await enrolTotp(f.cp, f.approver.accessToken);
    const start = await f.cp.app.request(
      `/v1/interactions/${f.ref}/activation`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${f.approver.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          method: "totp",
          decision: "approved",
          requestDigest: f.requestDigest,
        }),
      },
    );
    expect(start.status).toBe(201);
    const begun = overlapCast<{ activationId: string }>(await start.json());
    const failures = f.cp.ctx.stores.mfaFailures;
    const get = failures.get.bind(failures);
    let advanced = false;
    const spy = vi.spyOn(failures, "get").mockImplementation((key) => {
      const value = get(key);
      if (!advanced && key === `totp:${f.approver.principalId}`) {
        advanced = true;
        f.advance(300);
      }
      return value;
    });
    const response = await f.cp.app.request(
      `/v1/interactions/${f.ref}/activation/totp`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${f.approver.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          activationId: begun.activationId,
          code: totpCode(secret),
        }),
      },
    );
    spy.mockRestore();
    expect(advanced).toBe(true);
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: "activation_expired" });
    expect(
      (await f.cp.ctx.repos.approvalActivations.getById(begun.activationId))
        ?.state,
    ).toBe("pending");
    expect(
      await f.cp.ctx.stores.totpSteps.get(f.approver.principalId),
    ).toBeUndefined();
  });
  it("rejects completion after a TOTP code is spent across the deadline", async () => {
    resetInteractionTotpBudget();
    const f = await fixture(600);
    const secret = await enrolTotp(f.cp, f.approver.accessToken);
    const start = await f.cp.app.request(
      `/v1/interactions/${f.ref}/activation`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${f.approver.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          method: "totp",
          decision: "approved",
          requestDigest: f.requestDigest,
        }),
      },
    );
    expect(start.status).toBe(201);
    const begun = overlapCast<{ activationId: string }>(await start.json());
    const failures = f.cp.ctx.stores.totpSteps;
    const get = failures.get.bind(failures);
    let advanced = false;
    const spy = vi.spyOn(failures, "get").mockImplementation((key) => {
      const value = get(key);
      if (!advanced && key === f.approver.principalId) {
        advanced = true;
        f.advance(300);
      }
      return value;
    });
    const response = await f.cp.app.request(
      `/v1/interactions/${f.ref}/activation/totp`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${f.approver.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          activationId: begun.activationId,
          code: totpCode(secret),
        }),
      },
    );
    spy.mockRestore();
    expect(advanced).toBe(true);
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: "activation_expired" });
    expect(
      (await f.cp.ctx.repos.approvalActivations.getById(begun.activationId))
        ?.state,
    ).toBe("pending");
    expect(
      await f.cp.ctx.stores.totpSteps.get(f.approver.principalId),
    ).toBeDefined();
  });
});
