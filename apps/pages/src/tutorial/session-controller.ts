/**
 * Support session state machine. Split from `session.ts` so the React provider
 * can import the controller without a circular module graph at boot.
 */
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { clearMountedGuideTargets } from "@opensesame/app-core/tutorial/registry/targets.js";
import { loadBrowserEngine } from "./engine.js";
import type {
  SupportController,
  SupportSessionDependencies,
} from "./session.js";
import { buildSupportController } from "./session-controller-api.js";
import { createSessionAskMethods } from "./session-controller-ask.js";
import { SupportControllerCore } from "./session-controller-core.js";

export function createSupportController(
  dependencies: SupportSessionDependencies,
): SupportController {
  const core = new SupportControllerCore(dependencies);
  const askBinding = createSessionAskMethods({
    push: (...args) => core.push(...args),
    set: (patch) => core.set(patch),
    view: () => core.state,
    ensureEngine: () => core.ensureEngine(),
    engine: () => core.engine,
    cancelled: {
      get: () => core.cancelled,
      set: (value) => {
        core.cancelled = value;
      },
    },
    notifyFailure: (body) => core.notifyFailure(body),
    refreshAvailability: () => core.refreshAvailability(),
    runProgram: (program, origin) => core.runProgram(program, origin),
  });
  const resume = core.createQueuedResume();
  return buildSupportController(core, askBinding, resume);
}

/** Swapped wholesale by tests; the browser wiring is the default. */
export const supportSessionSeams: SupportSessionDependencies = {
  loadEngine: loadBrowserEngine,
  onLock: (handler) => vaultStore.onLock(handler),
  clearTargets: clearMountedGuideTargets,
};
