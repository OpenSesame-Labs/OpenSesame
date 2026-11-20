/** @vitest-environment jsdom */

import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { afterEach, describe, expect, it } from "vitest";
import type { SupportEngine } from "./engine.js";
import { createSupportController } from "./session-controller.js";
import { stubQueuedResumeEngine } from "./session-controller.queue-resume.test-support.js";
import { SUPPORT_ERROR_TEXT, UNEXPECTED_TEXT } from "./ui/messages.js";

afterEach(() => {
  clearNotices();
});

function failures(): string[] {
  return listNotices()
    .filter((notice) => notice.id === "support.failure")
    .map((notice) => notice.body);
}

describe("session generation around engine load", () => {
  it("writes nothing when lock clears the session during ask", async () => {
    let resolver: (engine: SupportEngine) => void = () => {};
    const pending = new Promise<SupportEngine>((resolve) => {
      resolver = resolve;
    });
    const controller = createSupportController({
      loadEngine: () => pending,
      onLock: () => () => {},
      clearTargets: () => {},
    });
    const asking = controller.ask("How do I lock the vault?");
    expect(controller.view().transcript.map((entry) => entry.kind)).toEqual([
      "question",
    ]);
    controller.lock();
    expect(controller.view().transcript).toEqual([]);
    resolver(stubQueuedResumeEngine(false));
    await asking;
    expect(controller.view().transcript).toEqual([]);
    expect(failures()).toEqual([]);
    expect(failures()).not.toContain(SUPPORT_ERROR_TEXT.AGENT_UNAVAILABLE);
    controller.destroy();
  });

  it("keeps the unexpected-load notice and does not add agent unavailable", async () => {
    const controller = createSupportController({
      loadEngine: () => Promise.reject(new Error("load failed")),
      onLock: () => () => {},
      clearTargets: () => {},
    });
    await controller.startGuide("vault.lock", "authored");
    expect(failures()).toEqual([UNEXPECTED_TEXT]);
    controller.destroy();
  });

  it("runs one guide when two starts share one engine load", async () => {
    let resolver: (engine: SupportEngine) => void = () => {};
    const pending = new Promise<SupportEngine>((resolve) => {
      resolver = resolve;
    });
    let runs = 0;
    const engine = stubQueuedResumeEngine(false);
    engine.runGuide = () => {
      runs += 1;
      return Promise.resolve({ kind: "completed", goal: "vault.lock" });
    };
    const controller = createSupportController({
      loadEngine: () => pending,
      onLock: () => () => {},
      clearTargets: () => {},
    });
    const first = controller.startGuide("vault.lock", "authored");
    const second = controller.startGuide("vault.lock", "authored");
    resolver(engine);
    await Promise.all([first, second]);
    expect(runs).toBe(1);
    controller.destroy();
  });

  it("does not notify or run a guide when lock wins the load", async () => {
    let resolver: (engine: SupportEngine) => void = () => {};
    const pending = new Promise<SupportEngine>((resolve) => {
      resolver = resolve;
    });
    let runs = 0;
    let destroyed = 0;
    const engine = stubQueuedResumeEngine(false);
    engine.runGuide = () => {
      runs += 1;
      return Promise.resolve({ kind: "completed", goal: "vault.lock" });
    };
    engine.destroy = () => {
      destroyed += 1;
    };
    const controller = createSupportController({
      loadEngine: () => pending,
      onLock: () => () => {},
      clearTargets: () => {},
    });
    const starting = controller.startGuide("vault.lock", "authored");
    controller.lock();
    resolver(engine);
    await starting;
    expect(runs).toBe(0);
    expect(destroyed).toBe(1);
    expect(failures()).toEqual([]);
    controller.destroy();
  });
});
