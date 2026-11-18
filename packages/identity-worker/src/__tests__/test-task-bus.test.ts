import { createRepositories } from "@opensesame/database";
import { createTestTaskBus } from "@opensesame/identity-worker/testkit";
import { withTestResources } from "@opensesame/testing";
import { describe, expect, it } from "vitest";
import { createFakeClock, runCleanupTick } from "../cleanup.js";
import { type BusEvent, MemoryTaskBus } from "../taskBus.js";

const event: BusEvent = {
  id: "event-1",
  specversion: "1.0",
  source: "opensesame/outbox/principal",
  type: "principal.created",
  time: "2026-11-17T00:00:00.000Z",
  data: { principalId: "person-1" },
};

describe.each([
  { name: "memory", create: () => new MemoryTaskBus() },
  {
    name: "test double",
    create: () => createTestTaskBus({ publishScript: ["success", "success"] }),
  },
])("$name TaskBus contract", ({ create }) => {
  it("accepts and records events in publish order", async () => {
    const bus = create();
    await bus.publish(event);
    await bus.publish({ ...event, id: "event-2" });
    expect(bus.published.map((item) => item.id)).toEqual([
      "event-1",
      "event-2",
    ]);
    expect(bus.published[0]).toEqual(event);
  });
});

describe("test TaskBus", () => {
  it("rewinds its script on reset, isolates instances, and closes", async () => {
    const bus = createTestTaskBus({
      publishScript: [new Error("unavailable"), "success"],
    });
    const other = createTestTaskBus();
    await expect(bus.publish(event)).rejects.toThrow("unavailable");
    await bus.publish(event);
    await expect(bus.publish(event)).rejects.toThrow(/script exhausted/);
    expect(bus.attempts).toHaveLength(3);
    expect(bus.published).toEqual([event]);
    expect(other.published).toHaveLength(0);

    bus.reset();
    expect(bus.attempts).toHaveLength(0);
    expect(bus.published).toHaveLength(0);
    await expect(bus.publish(event)).rejects.toThrow("unavailable");
    await bus.close();
    await bus.close();
    expect(bus.attempts).toHaveLength(0);
    await expect(bus.publish(event)).rejects.toThrow(/closed/);
    expect(() => bus.reset()).toThrow(/closed/);
    await other.publish(event);
    expect(other.published).toEqual([event]);
  });

  it("keeps an outbox event after failure and publishes it on retry", async () => {
    await withTestResources(async (scope) => {
      const clock = createFakeClock(new Date("2026-11-17T00:00:00.000Z"));
      const repos = createRepositories();
      await repos.outbox.append({
        id: "outbox-1",
        aggregateType: "principal",
        aggregateId: "person-1",
        eventType: "principal.created",
        payload: { principalId: "person-1" },
        availableAt: clock.now,
      });
      const taskBus = scope.use(
        createTestTaskBus({
          publishScript: [new Error("unavailable"), "success"],
        }),
      );
      const deps = { repos, clock: clock.asClock(), taskBus };

      expect((await runCleanupTick(deps)).outboxPublished).toBe(0);
      expect(
        (await repos.outbox.listUnpublished()).map((row) => row.id),
      ).toEqual(["outbox-1"]);
      expect(taskBus.published).toHaveLength(0);
      expect((await runCleanupTick(deps)).outboxPublished).toBe(1);
      expect(await repos.outbox.listUnpublished()).toHaveLength(0);
      expect(taskBus.attempts.map((item) => item.id)).toEqual([
        "outbox-1",
        "outbox-1",
      ]);
      expect(taskBus.published).toHaveLength(1);
      expect(taskBus.published[0]).toMatchObject({
        id: "outbox-1",
        type: "principal.created",
        data: { principalId: "person-1" },
      });
      expect((await runCleanupTick(deps)).outboxPublished).toBe(0);
      expect(taskBus.attempts).toHaveLength(2);
    });
  });
});
