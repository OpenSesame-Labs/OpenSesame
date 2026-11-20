import { completeQueuedTutorial } from "@opensesame/app-core/lib/tutorial-queue.js";
import { guideGoal } from "@opensesame/app-core/tutorial/registry/goals.js";
import {
  GUIDE_OVERLAY_ROUTES,
  type GuideRouteId,
  guideRouteWithin,
} from "@opensesame/app-core/tutorial/registry/routes.js";
import type { SupportEngine } from "./engine.js";
import type { SupportView } from "./session.js";
import { SUPPORT_ERROR_TEXT } from "./ui/messages.js";

export type PendingQueuedResume = {
  goalId: string;
  guide: string;
  homeRoute: string;
};

export type QueuedResumeHost = {
  getState: () => SupportView;
  getEngine: () => SupportEngine | null;
  ensureEngine: () => Promise<SupportEngine | null>;
  loadGeneration: () => number;
  getNavigator: () => ((route: GuideRouteId) => boolean) | null;
  getPending: () => PendingQueuedResume | null;
  setPending: (value: PendingQueuedResume | null) => void;
  guideRunning: () => boolean;
  queuedResumeLoading: () => boolean;
  setQueuedResumeLoading: (loading: boolean) => void;
  notifyFailure: (body: string) => void;
  runAuthoredProgram: (loaded: SupportEngine, guide: string) => boolean;
};

export function createQueuedResumeHandlers(host: QueuedResumeHost) {
  function queuedResumeRouteOk(homeRoute: string): boolean {
    const state = host.getState();
    if (homeRoute === "") return !GUIDE_OVERLAY_ROUTES.has(state.route);
    return guideRouteWithin(state.route, homeRoute);
  }

  function beginQueuedWalkthrough(
    goalId: string,
    guide: string,
    homeRoute: string,
  ): boolean {
    if (host.guideRunning() || host.queuedResumeLoading()) return false;
    if (!queuedResumeRouteOk(homeRoute)) return false;
    const beginAuthored = (loaded: SupportEngine) => {
      if (host.guideRunning()) return false;
      if (!queuedResumeRouteOk(homeRoute)) return false;
      if (!host.runAuthoredProgram(loaded, guide)) return false;
      completeQueuedTutorial(goalId);
      return true;
    };
    const engine = host.getEngine();
    if (engine) {
      if (!beginAuthored(engine)) return false;
      return true;
    }
    host.setQueuedResumeLoading(true);
    const era = host.loadGeneration();
    void host
      .ensureEngine()
      .then((loaded) => {
        if (host.loadGeneration() !== era) return;
        if (!loaded) {
          host.notifyFailure(SUPPORT_ERROR_TEXT.AGENT_UNAVAILABLE);
          return;
        }
        beginAuthored(loaded);
      })
      .finally(() => {
        if (host.loadGeneration() === era) {
          host.setQueuedResumeLoading(false);
        }
      });
    return true;
  }

  function flushPendingQueuedResume(): void {
    const pending = host.getPending();
    if (!pending) return;
    const { goalId, guide, homeRoute } = pending;
    if (!queuedResumeRouteOk(homeRoute)) return;
    host.setPending(null);
    host.setQueuedResumeLoading(false);
    beginQueuedWalkthrough(goalId, guide, homeRoute);
  }

  function resumeQueuedWalkthrough(
    goalId: string,
    guide: string,
    homeRoute: string,
  ): boolean {
    if (guideGoal(goalId) === null) return false;
    if (GUIDE_OVERLAY_ROUTES.has(homeRoute)) return false;
    if (host.guideRunning() || host.queuedResumeLoading()) return false;
    const onHome = queuedResumeRouteOk(homeRoute);
    if (!onHome) {
      if (!host.getNavigator()?.(homeRoute)) return false;
      host.setQueuedResumeLoading(true);
      host.setPending({ goalId, guide, homeRoute });
      void host.ensureEngine();
      return true;
    }
    return beginQueuedWalkthrough(goalId, guide, homeRoute);
  }

  return {
    queuedResumeRouteOk,
    beginQueuedWalkthrough,
    flushPendingQueuedResume,
    resumeQueuedWalkthrough,
  };
}
