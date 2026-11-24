import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { fixture, gate } from "./interaction-clock-fixture.js";
import {
  activateInteraction,
  enrolPasskey,
} from "./interaction-webauthn-fixture.js";

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

/**
 * CLOCK-1 at the unit of work: the clock crosses the deadline just before
 * the k-th application sample taken inside the consume transaction (k = the
 * sample count: after the last sample, before commit; none: never). Lean
 * (`uowOutcome` in spec/formal/interaction-clock) fixes the expected rows
 * when OPENSESAME_INTERACTION_CLOCK_UOW_VECTORS is set; the same cases are
 * listed here so the regression also runs on its own.
 */
const builtInCrossings = [
  "uow\t0\t410\tapproved\t0",
  "uow\t1\t410\tapproved\t0",
  "uow\t2\t410\tapproved\t0",
  "uow\t3\t410\tapproved\t0",
  "uow\t4\t410\tapproved\t0",
  "uow\t5\t410\tapproved\t0",
  "uow\t6\t200\tconsumed\t1",
  "uow\tnone\t200\tconsumed\t1",
];

function crossingRows(): string[] {
  const path = process.env.OPENSESAME_INTERACTION_CLOCK_UOW_VECTORS;
  if (!path) return builtInCrossings;
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter((row) => row.startsWith("uow\t"));
}

it("rolls back every consume whose transaction sees the deadline pass", async () => {
  const rows = crossingRows();
  expect(rows).toHaveLength(8);
  for (const row of rows) {
    const [, crossing, status, state, commits] = row.split("\t");
    const f = await fixture();
    await approveInteraction(f);
    const ctx = f.cp.ctx;
    const clock = ctx.clock;
    const transaction = ctx.repos.transaction.bind(ctx.repos);
    let inside = false;
    let samples = 0;
    ctx.clock = () => {
      if (inside && String(samples++) === crossing) f.advance(300);
      return clock();
    };
    const reservations = ctx.repos.executionReservations;
    const acquire = reservations.acquire.bind(reservations);
    const acquired: string[] = [];
    const held = vi
      .spyOn(reservations, "acquire")
      .mockImplementation(async (...args: Parameters<typeof acquire>) => {
        const reservation = await acquire(...args);
        acquired.push(reservation.id);
        return reservation;
      });
    const spy = vi
      .spyOn(ctx.repos, "transaction")
      .mockImplementation(async (run) =>
        transaction(async (uow) => {
          inside = true;
          try {
            const result = await run(uow);
            // After the last sample and before the commit.
            if (String(samples) === crossing) f.advance(300);
            return result;
          } finally {
            inside = false;
          }
        }),
      );
    const response = await f.cp.app.request(
      `/v1/interactions/${f.ref}/consume`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${f.requester.accessToken}` },
      },
    );
    spy.mockRestore();
    held.mockRestore();
    ctx.clock = clock;
    expect(String(response.status), row).toBe(status);
    expect((await ctx.repos.interactions.getById(f.id))?.status, row).toBe(
      state,
    );
    // The memory store keeps a rolled-back acquisition as an unfenced held
    // lease (Postgres discards it); what must not survive is a commit.
    const committed = await Promise.all(
      acquired.map(async (id) => (await reservations.getById(id))?.status),
    );
    expect(String(committed.filter((s) => s === "committed").length), row).toBe(
      commits,
    );
    // Six samples when every one is live; a refused sample is the last.
    const last = crossing === "none" ? 6 : Math.min(Number(crossing) + 1, 6);
    expect(samples, row).toBe(last);
  }
});
