/** @vitest-environment jsdom */

import {
  forgetGuidanceAnswers,
  guidanceSeams,
  loadGuidance,
} from "@opensesame/app-core/lib/guidance.js";
import * as notices from "@opensesame/app-core/lib/notices.js";
import {
  dequeueTutorial,
  listQueuedTutorials,
  queueTutorial,
} from "@opensesame/app-core/lib/tutorial-queue.js";
import { GUIDE_LANG_VERSION, type GuideProgram } from "@opensesame/guide-lang";
import type {
  GuideOutcome,
  GuideRuntimeSnapshot,
} from "@opensesame/guide-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupportEngine } from "./engine.js";
import { createSupportController } from "./session-controller.js";
import { QUEUED_RESUME_ROUTE_SETTLE_MS } from "./session-queued-resume.js";

const PROGRAM: GuideProgram = {
  version: GUIDE_LANG_VERSION,
  goal: "vault.lock",
  instructions: [{ kind: "end" }],
};

const RUNNING: GuideRuntimeSnapshot = {
  status: "running",
  goal: "vault.lock",
  index: 0,
  total: 1,
  runId: 1,
  message: null,
  error: null,
  tour: {
    step: 1,
    count: 1,
    kind: "narrate",
    message: "Queued.",
    target: null,
    side: null,
    action: false,
    degraded: false,
    canBack: false,
  },
};

function stubEngine(running: boolean): SupportEngine {
  return {
    transport: "none",
    warning: null,
    session: {
      snapshot: () => ({
        status: "idle",
        messages: [],
        program: null,
        guideError: null,
        grounding: null,
        suggestedQuestions: [],
        thoughts: null,
        computer: [],
        error: null,
        generation: 0,
      }),
      messages: () => [],
      subscribe: () => () => {},
      availability: () => Promise.resolve({ kind: "ready" }),
      ask: () => Promise.resolve(),
      cancel: () => {},
      clear: () => {},
      destroy: () => {},
    },
    compile: () => null,
    compileAuthored: () => ({ ...PROGRAM, goal: "vault.lock" }),
    runGuide: () => Promise.resolve({ kind: "completed", goal: "vault.lock" }),
    nextStep: () => {},
    backStep: () => {},
    restartGuide: () => {},
    pauseGuide: () => {},
    cancelGuide: () => {},
    subscribeGuide: (listener) => {
      if (running) listener(RUNNING);
      return () => {};
    },
    acquire: () => Promise.resolve({ kind: "acquired" }),
    destroy: () => {},
  };
}

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
      loadEngine: () => Promise.resolve(stubEngine(false)),
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
      loadEngine: () => Promise.resolve(stubEngine(true)),
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
    const engine = stubEngine(false);
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
    resolver(stubEngine(false));
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
    const engine = stubEngine(false);
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
    const engine = stubEngine(false);
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

  it("does not start a resume after the route leaves its home", async () => {
    let runs = 0;
    const engine = stubEngine(false);
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
      const engine = stubEngine(false);
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
      const engine = stubEngine(false);
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
    const engine = stubEngine(false);
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

  it("records a library walkthrough as answered when it completes", async () => {
    let resolveRun: (outcome: GuideOutcome) => void = () => {};
    const engine = stubEngine(false);
    engine.compileAuthored = () => ({ ...PROGRAM, goal: "vault.lock" });
    const controller = createSupportController({
      loadEngine: () => Promise.resolve(engine),
      onLock: () => () => {},
      clearTargets: () => {},
    });
    controller.setRoute("/vault");
    queueTutorial("vault.lock", { title: "Lock the vault" });
    let started = false;
    engine.runGuide = () => {
      started = true;
      return new Promise((resolve) => {
        resolveRun = resolve;
      });
    };
    const running = controller.startGuide("guide", "authored");
    await vi.waitFor(() => expect(started).toBe(true));
    expect(listQueuedTutorials()).toEqual([{ goalId: "vault.lock" }]);
    expect(loadGuidance().tours).toEqual([]);
    resolveRun({ kind: "completed", goal: "vault.lock" });
    await running;
    expect(loadGuidance().tours).toEqual(["vault.lock"]);
    expect(listQueuedTutorials()).toEqual([]);
    controller.destroy();
  });

  it("records a completed walkthrough after lock clears the engine", async () => {
    let resolveRun: (outcome: GuideOutcome) => void = () => {};
    const engine = stubEngine(false);
    engine.compileAuthored = () => ({
      ...PROGRAM,
      goal: "settings.danger.review",
    });
    const controller = createSupportController({
      loadEngine: () => Promise.resolve(engine),
      onLock: () => () => {},
      clearTargets: () => {},
    });
    controller.setRoute("/settings");
    queueTutorial("settings.danger.review", { title: "Danger" });
    let started = false;
    engine.runGuide = () => {
      started = true;
      return new Promise((resolve) => {
        resolveRun = resolve;
      });
    };
    const running = controller.startGuide("guide", "authored");
    await vi.waitFor(() => expect(started).toBe(true));
    controller.lock();
    resolveRun({ kind: "completed", goal: "settings.danger.review" });
    await running;
    expect(loadGuidance().tours).toEqual(["settings.danger.review"]);
    expect(listQueuedTutorials()).toEqual([]);
    controller.destroy();
  });

  it("records the lock walkthrough when lock cancels the running guide", async () => {
    let resolveRun: (outcome: GuideOutcome) => void = () => {};
    const engine = stubEngine(false);
    engine.compileAuthored = () => ({ ...PROGRAM, goal: "vault.lock" });
    const controller = createSupportController({
      loadEngine: () => Promise.resolve(engine),
      onLock: () => () => {},
      clearTargets: () => {},
    });
    controller.setRoute("/vault");
    queueTutorial("vault.lock", { title: "Lock the vault" });
    let started = false;
    engine.runGuide = () => {
      started = true;
      return new Promise((resolve) => {
        resolveRun = resolve;
      });
    };
    engine.cancelGuide = (reason) => {
      resolveRun({ kind: "cancelled", goal: "vault.lock", reason });
    };
    const running = controller.startGuide("guide", "authored");
    await vi.waitFor(() => expect(started).toBe(true));
    expect(loadGuidance().tours).toEqual([]);
    controller.lock();
    await running;
    expect(loadGuidance().tours).toEqual(["vault.lock"]);
    expect(listQueuedTutorials()).toEqual([]);
    controller.destroy();
  });

  it("does not record a different tour when lock cancels it", async () => {
    let resolveRun: (outcome: GuideOutcome) => void = () => {};
    const engine = stubEngine(false);
    engine.compileAuthored = () => ({
      ...PROGRAM,
      goal: "settings.danger.review",
    });
    const controller = createSupportController({
      loadEngine: () => Promise.resolve(engine),
      onLock: () => () => {},
      clearTargets: () => {},
    });
    controller.setRoute("/settings");
    queueTutorial("settings.danger.review", { title: "Danger" });
    let started = false;
    engine.runGuide = () => {
      started = true;
      return new Promise((resolve) => {
        resolveRun = resolve;
      });
    };
    engine.cancelGuide = (reason) => {
      resolveRun({ kind: "cancelled", goal: "settings.danger.review", reason });
    };
    const running = controller.startGuide("guide", "authored");
    await vi.waitFor(() => expect(started).toBe(true));
    controller.lock();
    await running;
    expect(loadGuidance().tours).toEqual([]);
    expect(listQueuedTutorials()).toEqual([
      { goalId: "settings.danger.review" },
    ]);
    controller.destroy();
  });
});
