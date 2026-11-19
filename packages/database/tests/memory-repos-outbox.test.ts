import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MemoryRepositories,
  NotFoundError,
  appendOutboxInTransaction,
} from "../src/index.js";
import { OUTBOX_CLAIM_HOLD_MS } from "../src/repos/interfaces.js";
import { makePrincipal } from "./factories.js";

describe("MemoryRepositories.outbox", () => {
  function makeEvent(id = `ob_${randomUUID()}`) {
    return {
      id,
      aggregateType: "principal",
      aggregateId: `prn_${randomUUID()}`,
      eventType: "principal.created",
      payload: { ok: true },
    };
  }

  it("generates an id when the event id is empty and defaults availability", async () => {
    const repos = new MemoryRepositories();
    const appended = await repos.outbox.append({ ...makeEvent("") });
    expect(appended.id).not.toBe("");
    expect(appended.attempts).toBe(0);
    expect(appended.availableAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("lists only unpublished, unheld rows in availability order", async () => {
    const repos = new MemoryRepositories();
    const now = Date.now();
    const late = await repos.outbox.append({
      ...makeEvent(),
      availableAt: new Date(now + 60_000),
    });
    const early = await repos.outbox.append({
      ...makeEvent(),
      availableAt: new Date(now - 60_000),
    });
    // Note: listUnpublished does not filter on availability, only on holds.
    const listed = await repos.outbox.listUnpublished();
    expect(listed.map((e) => e.id)).toEqual([early.id, late.id]);

    const limited = await repos.outbox.listUnpublished(1);
    expect(limited.map((e) => e.id)).toEqual([early.id]);
  });

  it("claim stamps a hold, bumps attempts, and skips unavailable rows", async () => {
    const repos = new MemoryRepositories();
    const ready = await repos.outbox.append(makeEvent());
    const future = await repos.outbox.append({
      ...makeEvent(),
      availableAt: new Date(Date.now() + 3_600_000),
    });
    const now = new Date();

    const claimed = await repos.outbox.claimUnpublished(100, now, 30_000);
    expect(claimed.map((e) => e.id)).toEqual([ready.id]);
    expect(claimed[0]?.attempts).toBe(1);
    expect(claimed[0]?.lastError).toBe(`claim:${now.getTime() + 30_000}`);

    // Held: invisible to a second claimant at the same instant.
    expect(await repos.outbox.claimUnpublished(100, now, 30_000)).toEqual([]);
    expect(
      (await repos.outbox.listUnpublished()).some((e) => e.id === ready.id),
    ).toBe(false);
    // The future row was never claimed and stays listed.
    expect(
      (await repos.outbox.listUnpublished()).some((e) => e.id === future.id),
    ).toBe(true);

    // Expired hold: claimable again, attempts keep counting.
    const later = new Date(now.getTime() + OUTBOX_CLAIM_HOLD_MS + 1);
    const reclaimed = await repos.outbox.claimUnpublished(100, later, 30_000);
    expect(reclaimed.map((e) => e.id)).toEqual([ready.id]);
    expect(reclaimed[0]?.attempts).toBe(2);
  });

  it("claim honors the limit", async () => {
    const repos = new MemoryRepositories();
    await repos.outbox.append(makeEvent());
    await repos.outbox.append(makeEvent());
    const claimed = await repos.outbox.claimUnpublished(1, new Date(), 30_000);
    expect(claimed).toHaveLength(1);
  });

  it("releaseClaim records errors, clears claims, and ignores settled rows", async () => {
    const repos = new MemoryRepositories();
    const a = await repos.outbox.append(makeEvent());
    const b = await repos.outbox.append(makeEvent());
    const now = new Date();
    await repos.outbox.claimUnpublished(100, now, 30_000);

    await repos.outbox.releaseClaim(a.id, "nats down");
    await repos.outbox.releaseClaim(b.id);

    const listed = await repos.outbox.listUnpublished();
    expect(listed.find((e) => e.id === a.id)?.lastError).toBe("nats down");
    expect(listed.find((e) => e.id === b.id)?.lastError).toBeUndefined();

    // Unknown and already-published rows are silent no-ops.
    await repos.outbox.releaseClaim(`ob_${randomUUID()}`, "x");
    await repos.outbox.markPublished(a.id);
    await repos.outbox.releaseClaim(a.id);
    const after = await repos.outbox.listUnpublished();
    expect(after.some((e) => e.id === a.id)).toBe(false);
  });

  it("markPublished stamps once, ignores repeats, and misses unknown ids", async () => {
    const repos = new MemoryRepositories();
    const event = await repos.outbox.append(makeEvent());
    await repos.outbox.markPublished(event.id);
    // Repeat: no-op, keeps the first stamp.
    await repos.outbox.markPublished(event.id, new Date(0));
    await expect(
      repos.outbox.markPublished(`ob_${randomUUID()}`),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(
      (await repos.outbox.listUnpublished()).some((e) => e.id === event.id),
    ).toBe(false);
  });

  it("appendOutboxInTransaction wraps the append in a transaction", async () => {
    const repos = new MemoryRepositories();
    const id = `ob_${randomUUID()}`;
    const event = await appendOutboxInTransaction(repos, makeEvent(id));
    expect(event.id).toBe(id);
    expect((await repos.outbox.listUnpublished()).map((e) => e.id)).toContain(
      id,
    );
  });
});

describe("MemoryRepositories.transaction", () => {
  it("defers unit-of-work writes until the work completes", async () => {
    const repos = new MemoryRepositories();
    const principal = makePrincipal();
    await repos.transaction(async (uow) => {
      await repos.principals.create(principal, uow);
      // Not yet applied: still invisible outside the unit of work.
      expect(await repos.principals.getById(principal.id)).toBeNull();
    });
    expect(await repos.principals.getById(principal.id)).not.toBeNull();
  });

  it("applies nothing when the work throws", async () => {
    const repos = new MemoryRepositories();
    const principal = makePrincipal();
    await expect(
      repos.transaction(async (uow) => {
        await repos.principals.create(principal, uow);
        await uow.appendOutbox({
          id: `ob_${randomUUID()}`,
          aggregateType: "principal",
          aggregateId: principal.id,
          eventType: "principal.created",
          payload: {},
        });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await repos.principals.getById(principal.id)).toBeNull();
    expect(await repos.outbox.listUnpublished()).toEqual([]);
  });

  it("appends outbox events through the unit of work with defaults", async () => {
    const repos = new MemoryRepositories();
    await repos.transaction(async (uow) => {
      const event = await uow.appendOutbox({
        id: "",
        aggregateType: "principal",
        aggregateId: "prn_x",
        eventType: "principal.created",
        payload: {},
      });
      expect(event.id).not.toBe("");
      expect(event.attempts).toBe(0);
    });
  });
});
