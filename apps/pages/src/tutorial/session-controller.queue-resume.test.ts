/** @vitest-environment jsdom */

import * as notices from "@opensesame/app-core/lib/notices.js";
import {
  dequeueTutorial,
  listQueuedTutorials,
  queueTutorial,
} from "@opensesame/app-core/lib/tutorial-queue.js";
import { GUIDE_LANG_VERSION, type GuideProgram } from "@opensesame/guide-lang";
import type { GuideRuntimeSnapshot } from "@opensesame/guide-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupportEngine } from "./engine.js";
import { createSupportController } from "./session-controller.js";

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
  afterEach(() => {
    for (const item of listQueuedTutorials()) dequeueTutorial(item.goalId);
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
    const controller = createSupportController({
      loadEngine: () => Promise.resolve(stubEngine(false)),
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
});
