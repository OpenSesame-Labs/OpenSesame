/** @vitest-environment jsdom */
import { GUIDE_LANG_VERSION, type GuideProgram } from "@opensesame/guide-lang";
import type { GuideRuntimeSnapshot } from "@opensesame/guide-runtime";
import { describe, expect, it } from "vitest";
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

function stubEngine(
  runGuide: () => Promise<{ kind: "completed"; goal: string }>,
): SupportEngine {
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
    runGuide,
    nextStep: () => {},
    backStep: () => {},
    restartGuide: () => {},
    pauseGuide: () => {},
    cancelGuide: () => {},
    subscribeGuide: (listener) => {
      listener(DONE);
      return () => {};
    },
    acquire: () => Promise.resolve({ kind: "acquired" }),
    destroy: () => {},
  };
}

describe("startGuide after a terminal snapshot", () => {
  it("starts another tour when the previous run left status done", async () => {
    let runCalls = 0;
    const engine = stubEngine(() => {
      runCalls += 1;
      return Promise.resolve({ kind: "completed", goal: "vault.lock" });
    });
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
    expect(runCalls).toBe(1);
    controller.destroy();
  });
});
