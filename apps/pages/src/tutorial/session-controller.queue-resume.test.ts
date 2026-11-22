/** @vitest-environment jsdom */

import {
  forgetGuidanceAnswers,
  guidanceSeams,
} from "@opensesame/app-core/lib/guidance.js";
import * as notices from "@opensesame/app-core/lib/notices.js";
import {
  dequeueTutorial,
  listQueuedTutorials,
  queueTutorial,
} from "@opensesame/app-core/lib/tutorial-queue.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupportEngine } from "./engine.js";
import { createSupportController } from "./session-controller.js";
import { stubQueuedResumeEngine } from "./session-controller.queue-resume.test-support.js";
import { QUEUED_RESUME_ROUTE_SETTLE_MS } from "./session-queued-resume.js";

describe("resumeQueuedWalkthrough", () => {
  const originalGuidance = { ...guidanceSeams };
  let stored: string | null = null;

  beforeEach(() => {
    stored = null;
    guidanceSeams.read = () => stored;
    guidanceSeams.write = (value) => {
      stored = value;
    };
    forgetGuidanceAnswers();
  });

  afterEach(() => {
    for (const item of listQueuedTutorials()) dequeueTutorial(item.goalId);
    forgetGuidanceAnswers();
    Object.assign(guidanceSeams, originalGuidance);
  });

  it("rejects route-less resumes on gate overlay routes", () => {
    const controller = createSupportController({
      loadEngine: () => Promise.resolve(stubQueuedResumeEngine(false)),
      onLock: () => () => {},
      clearTargets: () => {},
    });
    controller.setRoute("/unlock");
    queueTutorial("vault.lock", { title: "Lock the vault" });
    expect(controller.resumeQueuedWalkthrough("vault.lock", "guide", "")).toBe(
      false,
    );
    expect(listQueuedTutorials()).toEqual([{ goalId: "vault.lock" }]);
    controller.destroy();
  });

  it("rejects while another walkthrough is running", async () => {
    const controller = createSupportController({
      loadEngine: () => Promise.resolve(stubQueuedResumeEngine(true)),
      onLock: () => () => {},
      clearTargets: () => {},
    });
    controller.setRoute("/vault");
    queueTutorial("settings.danger.review", { title: "Danger" });
    await controller.open("tutorials");
    await Promise.resolve();
    expect(
      controller.resumeQueuedWalkthrough(
        "settings.danger.review",
        "guide",
        "/settings",
      ),
    ).toBe(false);
    expect(listQueuedTutorials()).toEqual([
      { goalId: "settings.danger.review" },
    ]);
    controller.destroy();
  });

  it("clears queued resume loading when navigation leaves the tour home route", async () => {
    let runs = 0;
    const engine = stubQueuedResumeEngine(false);
    engine.runGuide = () => {
      runs += 1;
      return Promise.resolve({ kind: "completed", goal: "other-tour" });
    };
    const controller = createSupportController({
      loadEngine: () => Promise.resolve(engine),
      onLock: () => () => {},
      clearTargets: () => {},
    });
    controller.setRoute("/vault");
    controller.setNavigator(() => true);
    queueTutorial("settings.danger.review", { title: "Danger" });
    expect(
      controller.resumeQueuedWalkthrough(
        "settings.danger.review",
        "guide",
        "/settings",
      ),
    ).toBe(true);
    controller.setRoute("/vault/item");
    await Promise.resolve();
    await controller.startGuide("other-tour", "authored");
    expect(runs).toBe(1);
    expect(listQueuedTutorials()).toEqual([
      { goalId: "settings.danger.review" },
    ]);
    controller.destroy();
  });

  it("keeps the queue when the route changes before the engine loads", async () => {
    let resolver: (engine: SupportEngine) => void = () => {};
    const pending = new Promise<SupportEngine>((resolve) => {
      resolver = resolve;
    });
    const controller = createSupportController({
      loadEngine: () => pending,
      onLock: () => () => {},
      clearTargets: () => {},
    });
    controller.setRoute("/vault");
    controller.setNavigator(() => true);
    queueTutorial("settings.danger.review", { title: "Danger" });
    expect(
      controller.resumeQueuedWalkthrough(
        "settings.danger.review",
        "guide",
        "/settings",
      ),
    ).toBe(true);
    controller.setRoute("/vault/item");
    resolver(stubQueuedResumeEngine(false));
    await Promise.resolve();
    await Promise.resolve();
    expect(listQueuedTutorials()).toEqual([
      { goalId: "settings.danger.review" },
    ]);
    controller.destroy();
  });

  it("does not post agent unavailable when lock cancels a pending engine load", async () => {
    let resolver: (engine: SupportEngine) => void = () => {};
    const pending = new Promise<SupportEngine>((resolve) => {
      resolver = resolve;
    });
    const noticeSpy = vi.spyOn(notices, "setStatusNotice");
    const controller = createSupportController({
      loadEngine: () => pending,
      onLock: () => () => {},
      clearTargets: () => {},
    });
    controller.setRoute("/vault");
    queueTutorial("vault.lock", { title: "Lock the vault" });
    expect(
      controller.resumeQueuedWalkthrough("vault.lock", "guide", "/vault"),
    ).toBe(true);
    const engine = stubQueuedResumeEngine(false);
    controller.lock();
    resolver(engine);
    await Promise.resolve();
    await Promise.resolve();
    const failureNotices = noticeSpy.mock.calls.filter(
      ([notice]) => notice.id === "support.failure",
    );
    expect(failureNotices).toEqual([]);
    expect(listQueuedTutorials()).toEqual([{ goalId: "vault.lock" }]);
    noticeSpy.mockRestore();
    controller.destroy();
  });

  it("refuses startGuide while a queued resume waits on the engine", async () => {
    let runGuideCalls = 0;
    let resolver: (engine: SupportEngine) => void = () => {};
    const pending = new Promise<SupportEngine>((resolve) => {
      resolver = resolve;
    });
    const controller = createSupportController({
      loadEngine: () => pending,
      onLock: () => () => {},
      clearTargets: () => {},
    });
    const engine = stubQueuedResumeEngine(false);
    engine.runGuide = () => {
      runGuideCalls += 1;
      return Promise.resolve({ kind: "completed", goal: "vault.lock" });
    };
    controller.setRoute("/vault");
    queueTutorial("vault.lock", { title: "Lock the vault" });
    expect(
      controller.resumeQueuedWalkthrough("vault.lock", "guide", "/vault"),
    ).toBe(true);
    await controller.startGuide("other-tour", "authored");
    expect(runGuideCalls).toBe(0);
    resolver(engine);
    await vi.waitFor(() => expect(runGuideCalls).toBe(1));
    expect(listQueuedTutorials()).toEqual([]);
    controller.destroy();
  });

  it("does not start a stale resume on a later visit to its home", async () => {
    let runs = 0;
    const engine = stubQueuedResumeEngine(false);
    engine.runGuide = () => {
      runs += 1;
      return Promise.resolve({
        kind: "completed",
        goal: "settings.danger.review",
      });
    };
    const controller = createSupportController({
      loadEngine: () => Promise.resolve(engine),
      onLock: () => () => {},
      clearTargets: () => {},
    });
    controller.setRoute("/vault");
    controller.setNavigator(() => true);
    queueTutorial("settings.danger.review", { title: "Danger" });
    expect(
      controller.resumeQueuedWalkthrough(
        "settings.danger.review",
        "guide",
        "/settings",
      ),
    ).toBe(true);
    controller.setRoute("/vault/item");
    await Promise.resolve();
    controller.setRoute("/settings");
    await Promise.resolve();
    await Promise.resolve();
    expect(runs).toBe(0);
    expect(listQueuedTutorials()).toEqual([
      { goalId: "settings.danger.review" },
    ]);
    controller.destroy();
  });

  it("holds an off-route resume until route sync settles", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let runs = 0;
      const engine = stubQueuedResumeEngine(false);
      engine.runGuide = () => {
        runs += 1;
        return Promise.resolve({
          kind: "completed",
          goal: "settings.danger.review",
        });
      };
      const controller = createSupportController({
        loadEngine: () => Promise.resolve(engine),
        onLock: () => () => {},
        clearTargets: () => {},
      });
      controller.setRoute("/vault");
      controller.setNavigator(() => true);
      queueTutorial("settings.danger.review", { title: "Danger" });
      expect(
        controller.resumeQueuedWalkthrough(
          "settings.danger.review",
          "guide",
          "/settings",
        ),
      ).toBe(true);
      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(QUEUED_RESUME_ROUTE_SETTLE_MS - 1);
      expect(runs).toBe(0);
      await controller.startGuide("other-tour", "authored");
      expect(runs).toBe(0);
      controller.setRoute("/settings");
      await Promise.resolve();
      expect(runs).toBe(1);
      vi.advanceTimersByTime(1);
      expect(runs).toBe(1);
      expect(listQueuedTutorials()).toEqual([]);
      controller.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("abandons a resume when navigation never updates the route", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let runs = 0;
      const engine = stubQueuedResumeEngine(false);
      engine.runGuide = () => {
        runs += 1;
        return Promise.resolve({ kind: "completed", goal: "other-tour" });
      };
      const controller = createSupportController({
        loadEngine: () => Promise.resolve(engine),
        onLock: () => () => {},
        clearTargets: () => {},
      });
      controller.setRoute("/vault");
      controller.setNavigator(() => true);
      queueTutorial("settings.danger.review", { title: "Danger" });
      expect(
        controller.resumeQueuedWalkthrough(
          "settings.danger.review",
          "guide",
          "/settings",
        ),
      ).toBe(true);
      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(QUEUED_RESUME_ROUTE_SETTLE_MS);
      expect(runs).toBe(0);
      controller.setRoute("/settings");
      await Promise.resolve();
      expect(runs).toBe(0);
      expect(listQueuedTutorials()).toEqual([
        { goalId: "settings.danger.review" },
      ]);
      await controller.startGuide("other-tour", "authored");
      expect(runs).toBe(1);
      controller.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts a resume when home arrives after the engine is ready", async () => {
    let runs = 0;
    const engine = stubQueuedResumeEngine(false);
    engine.runGuide = () => {
      runs += 1;
      return Promise.resolve({
        kind: "completed",
        goal: "settings.danger.review",
      });
    };
    const controller = createSupportController({
      loadEngine: () => Promise.resolve(engine),
      onLock: () => () => {},
      clearTargets: () => {},
    });
    controller.setRoute("/vault");
    controller.setNavigator(() => true);
    queueTutorial("settings.danger.review", { title: "Danger" });
    expect(
      controller.resumeQueuedWalkthrough(
        "settings.danger.review",
        "guide",
        "/settings",
      ),
    ).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(runs).toBe(0);
    controller.setRoute("/settings");
    await Promise.resolve();
    expect(runs).toBe(1);
    controller.destroy();
  });
});
