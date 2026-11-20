/** @vitest-environment jsdom */
import { GUIDE_LANG_VERSION, type GuideProgram } from "@opensesame/guide-lang";
import type { GuideRuntimeSnapshot } from "@opensesame/guide-runtime";
import { describe, expect, it, vi } from "vitest";
import type { SupportEngine } from "./engine.js";
import { createSupportController } from "./session-controller.js";

const PROGRAM: GuideProgram = {
  version: GUIDE_LANG_VERSION,
  goal: "vault.lock",
  instructions: [{ kind: "end" }],
};

const DONE: GuideRuntimeSnapshot = {
  status: "done",
  goal: "vault.lock",
  index: 0,
  total: 1,
  runId: 1,
  message: null,
  error: null,
  tour: null,
};

function stubEngine(onSubscribe?: (listener: (s: GuideRuntimeSnapshot) => void) => void): SupportEngine {
  let runCalls = 0;
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
    runGuide: () => {
      runCalls += 1;
      return Promise.resolve({ kind: "completed", goal: "vault.lock" });
    },
    nextStep: () => {},
    backStep: () => {},
    restartGuide: () => {},
    pauseGuide: () => {},
    cancelGuide: () => {},
    subscribeGuide: (listener) => {
      onSubscribe?.(listener);
      listener(DONE);
      return () => {};
    },
    acquire: () => Promise.resolve({ kind: "acquired" }),
    destroy: () => {},
    get runCalls() {
      return runCalls;
    },
  } as SupportEngine & { runCalls: number };
}

describe("startGuide after a terminal snapshot", () => {
  it("starts another tour when the previous run left status done", async () => {
    const engine = stubEngine();
    const controller = createSupportController({
      loadEngine: () => Promise.resolve(engine),
      onLock: () => () => {},
      clearTargets: () => {},
    });
    await controller.open("tutorials");
    await Promise.resolve();
    expect(controller.view().guide?.status).toBe("done");
    await controller.startGuide("vault.lock", "authored");
    await Promise.resolve();
    expect((engine as SupportEngine & { runCalls: number }).runCalls).toBe(1);
    controller.destroy();
  });
});