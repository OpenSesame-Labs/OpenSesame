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

  function beginQueuedWalkthrough(guide: string, homeRoute: string): boolean {
    if (host.guideRunning() || host.queuedResumeLoading()) return false;
    if (!queuedResumeRouteOk(homeRoute)) return false;
    const beginAuthored = (loaded: SupportEngine) => {
      if (host.guideRunning()) return false;
      if (!queuedResumeRouteOk(homeRoute)) return false;
      return host.runAuthoredProgram(loaded, guide);
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
    const { guide, homeRoute } = pending;
    if (!queuedResumeRouteOk(homeRoute)) {
      // Home was never reached. A later visit must not start this resume.
      host.setPending(null);
      host.setQueuedResumeLoading(false);
      return;
    }
    host.setPending(null);
    host.setQueuedResumeLoading(false);
    beginQueuedWalkthrough(guide, homeRoute);
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
      const era = host.loadGeneration();
      const armedRoute = host.getState().route;
      const abandonIfHomeNeverLanded = () => {
        if (host.loadGeneration() !== era) return;
        const pending = host.getPending();
        if (pending?.goalId !== goalId || pending.homeRoute !== homeRoute) {
          return;
        }
        if (queuedResumeRouteOk(homeRoute)) return;
        host.setPending(null);
        host.setQueuedResumeLoading(false);
      };
      void host
        .ensureEngine()
        .then((loaded) => {
          if (host.loadGeneration() !== era) return;
          const pending = host.getPending();
          if (pending?.goalId !== goalId || pending.homeRoute !== homeRoute) {
            return;
          }
          if (!loaded) {
            host.setPending(null);
            host.setQueuedResumeLoading(false);
            host.notifyFailure(SUPPORT_ERROR_TEXT.AGENT_UNAVAILABLE);
            return;
          }
          if (!queuedResumeRouteOk(homeRoute)) return;
          host.setPending(null);
          host.setQueuedResumeLoading(false);
          beginQueuedWalkthrough(guide, homeRoute);
        })
        .finally(() => {
          if (host.loadGeneration() !== era) return;
          const pending = host.getPending();
          if (pending?.goalId !== goalId || pending.homeRoute !== homeRoute) {
            return;
          }
          if (queuedResumeRouteOk(homeRoute)) return;
          // Preload finished off the tour's home. A redirect or wander has
          // already moved the route: drop the reservation now. If the route
          // never moved, give the navigation one turn to commit. When that
          // turn still misses home, abandon pending and release loading so a
          // later unrelated visit cannot start this walkthrough.
          if (host.getState().route !== armedRoute) {
            abandonIfHomeNeverLanded();
            return;
          }
          setTimeout(abandonIfHomeNeverLanded, 0);
        });
      return true;
    }
    return beginQueuedWalkthrough(guide, homeRoute);
  }

  return {
    queuedResumeRouteOk,
    beginQueuedWalkthrough,
    flushPendingQueuedResume,
    resumeQueuedWalkthrough,
  };
}
