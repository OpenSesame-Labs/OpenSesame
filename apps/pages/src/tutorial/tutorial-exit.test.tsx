/** @vitest-environment jsdom */
/**
 * Exit tutorial and Escape both call stopGuide() with no reason, which is a
 * person's exit. Only that reason queues the tour. A stop the offer takes
 * when the screen has moved on is "superseded" and leaves the queue alone.
 */

import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import {
  TUTORIAL_PAUSE_NOTICE,
  dequeueTutorial,
  listQueuedTutorials,
  setSessionTutorialsPaused,
} from "@opensesame/app-core/lib/tutorial-queue.js";
import {
  PAUSE_ALL_FOR_SESSION,
  RESUME_WALKTHROUGH,
} from "@opensesame/app-core/lib/tutorial-queue-present.js";
import { GUIDE_LANG_VERSION, type GuideProgram } from "@opensesame/guide-lang";
import type {
  GuideCancelReason,
  GuideOutcome,
} from "@opensesame/guide-runtime";
import type { SupportSession } from "@opensesame/support-agent";
import { afterEach, describe, expect, it } from "vitest";
import { type SupportEngine, createSupportController } from "./session.js";

const PROGRAM: GuideProgram = {
  version: GUIDE_LANG_VERSION,
  goal: "vault.lock",
  instructions: [{ kind: "end" }],
};

function idleSession(): SupportSession {
  return {
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
  };
}

function engineFor(goal: string): {
  engine: SupportEngine;
  started: string[];
  whenRunning: Promise<void>;
  stop(reason: GuideCancelReason): void;
} {
  const started: string[] = [];
  let pending: GuideCancelReason | null = null;
  let settle: ((outcome: GuideOutcome) => void) | null = null;
  let markRunning: () => void = () => {};
  const whenRunning = new Promise<void>((resolve) => {
    markRunning = resolve;
  });
  const finish = (reason: GuideCancelReason) => {
    const outcome: GuideOutcome = { kind: "cancelled", goal, reason };
    if (settle) settle(outcome);
    else pending = reason;
  };
  const engine: SupportEngine = {
    transport: "none",
    warning: null,
    session: idleSession(),
    compile: () => null,
    compileAuthored: () => ({ ...PROGRAM, goal }),
    runGuide: () => {
      markRunning();
      return new Promise((resolve) => {
        if (pending) {
          resolve({ kind: "cancelled", goal, reason: pending });
          pending = null;
          return;
        }
        settle = resolve;
      });
    },
    nextStep: () => {},
    backStep: () => {},
    restartGuide: () => {},
    pauseGuide: () => {},
    cancelGuide: finish,
    subscribeGuide: () => () => {},
    acquire: () => Promise.resolve({ kind: "acquired" }),
    destroy: () => {},
  };
  return {
    engine,
    started,
    whenRunning,
    stop: finish,
  };
}

afterEach(() => {
  for (const item of listQueuedTutorials()) dequeueTutorial(item.goalId);
  setSessionTutorialsPaused(false);
  clearNotices();
});

describe("leaving a tour", () => {
  it("queues a person's exit and not a superseded stop", async () => {
    const user = engineFor("vault.lock");
    const controller = createSupportController({
      loadEngine: () => Promise.resolve(user.engine),
      onLock: () => () => {},
      clearTargets: () => {},
    });
    const navigated: string[] = [];
    controller.setNavigator((route) => {
      navigated.push(route);
    });
    const running = controller.startGuide("guide", "authored");
    await user.whenRunning;
    controller.stopGuide();
    await running;
    expect(listQueuedTutorials()).toEqual([{ goalId: "vault.lock" }]);
    expect(
      listNotices().some((notice) => notice.id === TUTORIAL_PAUSE_NOTICE),
    ).toBe(true);
    expect(
      listNotices().find((notice) => notice.id === TUTORIAL_PAUSE_NOTICE)?.act
        ?.label,
    ).toBe(PAUSE_ALL_FOR_SESSION);
    controller.destroy();

    const moved = engineFor("settings.danger.review");
    const other = createSupportController({
      loadEngine: () => Promise.resolve(moved.engine),
      onLock: () => () => {},
      clearTargets: () => {},
    });
    const leaving = other.startGuide("guide", "authored");
    await moved.whenRunning;
    other.stopGuide("superseded");
    await leaving;
    expect(listQueuedTutorials()).toEqual([{ goalId: "vault.lock" }]);
    other.destroy();
    void user.started;
    void navigated;
  });

  it("resumes a queued tour from its notice", async () => {
    const home = engineFor("settings.danger.review");
    const started: string[] = [];
    home.engine.compileAuthored = (source) => {
      started.push(source);
      return { ...PROGRAM, goal: "settings.danger.review" };
    };
    const controller = createSupportController({
      loadEngine: () => Promise.resolve(home.engine),
      onLock: () => () => {},
      clearTargets: () => {},
    });
    const navigated: string[] = [];
    controller.setRoute("/vault");
    controller.setNavigator((route) => {
      navigated.push(route);
    });
    const { queueTutorial, resumeTutorialFromNotice } = await import(
      "@opensesame/app-core/lib/tutorial-queue.js"
    );
    queueTutorial("settings.danger.review", { title: "Tour Settings: Danger" });
    expect(resumeTutorialFromNotice("settings.danger.review")).toBe(true);
    await home.whenRunning;
    expect(navigated).toEqual(["/settings"]);
    expect(
      started.some((source) => source.includes("settings.danger.review")),
    ).toBe(true);
    expect(
      listNotices().some((notice) => notice.act?.label === RESUME_WALKTHROUGH),
    ).toBe(false);
    controller.destroy();
  });
});
