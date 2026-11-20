import {
  type TutorialResumeStart,
  bindTutorialResume,
} from "@opensesame/app-core/lib/tutorial-queue.js";
import type { GuideRouteId } from "@opensesame/app-core/tutorial/registry/routes.js";
import type { GuideCancelReason } from "@opensesame/guide-runtime";
import type { GuideOrigin } from "./engine.js";
import type { SupportController, SupportTab } from "./session.js";
import { SUPPORT_ERROR_TEXT } from "./ui/messages.js";
import {
  type SupportAskBinding,
  SupportControllerCore,
} from "./session-controller-core.js";

export function buildSupportController(
  core: SupportControllerCore,
  askBinding: SupportAskBinding,
  resume: {
    flushPendingQueuedResume: () => void;
    resumeQueuedWalkthrough: SupportController["resumeQueuedWalkthrough"];
  },
): SupportController {
  return {
    ...buildSupportSubscriptionApi(core),
    ...buildSupportPanelApi(core, resume.flushPendingQueuedResume),
    ...buildSupportTranscriptApi(core, askBinding),
    ...buildSupportModelApi(core),
    ...buildSupportGuideApi(core),
    bindTutorialResume: (start: TutorialResumeStart) =>
      bindSupportTutorialResume(core, start),
    resumeQueuedWalkthrough: resume.resumeQueuedWalkthrough,
    lock: () => core.clearSessionForLock(),
    destroy: () => destroySupportController(core),
  };
}

function buildSupportSubscriptionApi(core: SupportControllerCore) {
  return {
    subscribe(listener: () => void) {
      core.listeners.add(listener);
      return () => {
        core.listeners.delete(listener);
      };
    },
    view() {
      return core.state;
    },
  };
}

function buildSupportPanelApi(
  core: SupportControllerCore,
  flushPendingQueuedResume: () => void,
) {
  return {
    open(tab?: SupportTab) {
      if (core.state.open) return;
      const initialTab =
        tab ?? (core.state.transcript.length === 0 ? "tutorials" : "ask");
      core.set({ open: true, initialTab });
      void core.refreshAvailability();
    },
    close() {
      core.set({ open: false });
    },
    setRoute(route: GuideRouteId) {
      if (core.state.route === route) return;
      core.set({ route });
      for (const listener of [...core.routeListeners]) listener();
      flushPendingQueuedResume();
    },
    setNavigator(next: (route: GuideRouteId) => boolean) {
      core.navigator = next;
    },
  };
}

function buildSupportTranscriptApi(
  core: SupportControllerCore,
  askBinding: SupportAskBinding,
) {
  return {
    ask: askBinding.ask,
    cancel: askBinding.cancel,
    clear() {
      core.engine?.session.clear();
      core.set({ transcript: [] });
    },
    answerFromAuthoredHelp: askBinding.answerFromAuthoredHelp,
  };
}

function buildSupportModelApi(core: SupportControllerCore) {
  return {
    async acquireModel() {
      const loaded = await core.ensureEngine();
      if (!loaded) return;
      core.set({ availability: { kind: "downloading", progress: 0 } });
      const result = await loaded.acquire((progress) => {
        if (core.engine !== loaded) return;
        core.set({ availability: { kind: "downloading", progress } });
      });
      if (core.engine !== loaded) return;
      if (result.kind === "failed") {
        core.notifyFailure(SUPPORT_ERROR_TEXT[result.code]);
      }
      await core.refreshAvailability();
    },
  };
}

function buildSupportGuideApi(core: SupportControllerCore) {
  return {
    startGuide: (source: string, origin?: GuideOrigin) =>
      core.startGuide(source, origin),
    pauseGuide() {
      core.engine?.pauseGuide();
    },
    nextStep() {
      core.engine?.nextStep();
    },
    backStep() {
      core.engine?.backStep();
    },
    replayGuide() {
      core.engine?.restartGuide();
    },
    stopGuide(reason: GuideCancelReason = "user") {
      core.engine?.cancelGuide(reason);
    },
  };
}

function bindSupportTutorialResume(
  core: SupportControllerCore,
  start: TutorialResumeStart,
): () => void {
  core.unbindResume?.();
  core.unbindResume = bindTutorialResume(start);
  return () => {
    if (core.unbindResume) {
      core.unbindResume();
      core.unbindResume = null;
    }
  };
}

function destroySupportController(core: SupportControllerCore): void {
  core.teardown();
  core.listeners.clear();
  core.routeListeners.clear();
}