/**
 * Engine stand-in for queued-resume controller tests. Test support: never
 * imported by the app. The real engine loads a model; these tests only need
 * a guide run they can resolve.
 */

import { GUIDE_LANG_VERSION, type GuideProgram } from "@opensesame/guide-lang";
import type { GuideRuntimeSnapshot } from "@opensesame/guide-runtime";
import type { SupportEngine } from "./engine.js";

export const QUEUED_RESUME_PROGRAM: GuideProgram = {
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

export function stubQueuedResumeEngine(running: boolean): SupportEngine {
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
    compileAuthored: () => ({ ...QUEUED_RESUME_PROGRAM, goal: "vault.lock" }),
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
