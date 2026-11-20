/** @vitest-environment jsdom */
import {
  dequeueTutorial,
  listQueuedTutorials,
  queueTutorial,
} from "@opensesame/app-core/lib/tutorial-queue.js";
import { GUIDE_LANG_VERSION, type GuideProgram } from "@opensesame/guide-lang";
import type { GuideRuntimeSnapshot } from "@opensesame/guide-runtime";
import type { SupportEngine } from "./engine.js";
import { afterEach, describe, expect, it } from "vitest";
import { createSupportController } from "./session-controller.js";

const PROGRAM: GuideProgram = {
  version: GUIDE_LANG_VERSION,
  goal: "vault.lock",
  instructions: [{ kind: "end" }],
};

const RUNNING: GuideRuntimeSnapshot = {
  phase: "running",
  stepIndex: 0,
  stepCount: 1,
  message: null,
  origin: "authored",
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
    runGuide: () =>
      Promise.resolve({ kind: "completed", goal: "vault.lock" }),
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
    expect(
      controller.resumeQueuedWalkthrough("vault.lock", "guide", ""),
    ).toBe(false);
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
    controller.setRoute("/settings/features");
    resolver(stubEngine(false));
    await Promise.resolve();
    await Promise.resolve();
    expect(listQueuedTutorials()).toEqual([
      { goalId: "settings.danger.review" },
    ]);
    controller.destroy();
  });
});