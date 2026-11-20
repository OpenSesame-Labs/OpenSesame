/** @vitest-environment jsdom */

import {
  forgetGuidanceAnswers,
  guidanceSeams,
  loadGuidance,
} from "@opensesame/app-core/lib/guidance.js";
import {
  dequeueTutorial,
  listQueuedTutorials,
  queueTutorial,
} from "@opensesame/app-core/lib/tutorial-queue.js";
import type { GuideOutcome } from "@opensesame/guide-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSupportController } from "./session-controller.js";
import {
  QUEUED_RESUME_PROGRAM,
  stubQueuedResumeEngine,
} from "./session-controller.queue-resume.test-support.js";

describe("queued walkthrough completion", () => {
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

  it("records a library walkthrough as answered when it completes", async () => {
    let resolveRun: (outcome: GuideOutcome) => void = () => {};
    const engine = stubQueuedResumeEngine(false);
    engine.compileAuthored = () => ({
      ...QUEUED_RESUME_PROGRAM,
      goal: "vault.lock",
    });
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
    const engine = stubQueuedResumeEngine(false);
    engine.compileAuthored = () => ({
      ...QUEUED_RESUME_PROGRAM,
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
    const engine = stubQueuedResumeEngine(false);
    engine.compileAuthored = () => ({
      ...QUEUED_RESUME_PROGRAM,
      goal: "vault.lock",
    });
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
    const engine = stubQueuedResumeEngine(false);
    engine.compileAuthored = () => ({
      ...QUEUED_RESUME_PROGRAM,
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
