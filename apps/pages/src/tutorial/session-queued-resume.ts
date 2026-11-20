import { guideGoal } from "@opensesame/app-core/tutorial/registry/goals.js";
import {
  GUIDE_OVERLAY_ROUTES,
  type GuideRouteId,
  guideRouteWithin,
} from "@opensesame/app-core/tutorial/registry/routes.js";
import type { SupportEngine } from "./engine.js";
import type { SupportView } from "./session.js";
import { SUPPORT_ERROR_TEXT } from "./ui/messages.js";

/**
 * How long an off-route Resume may wait for the router to commit its home.
 * A suspended or lazily composed screen can take longer than one timer turn;
 * abandoning sooner drops the reservation before `useSupportRouteSync` reports
 * the destination. Past this, home did not land and the reservation is released.
 */
export const QUEUED_RESUME_ROUTE_SETTLE_MS = 5_000;

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
  let routeSettleTimer: ReturnType<typeof setTimeout> | null = null;

  function clearRouteSettleTimer(): void {
    if (routeSettleTimer === null) return;
    clearTimeout(routeSettleTimer);
    routeSettleTimer = null;
  }

  function queuedResumeRouteOk(homeRoute: string): boolean {
    const state = host.getState();
    if (homeRoute === "") return !GUIDE_OVERLAY_ROUTES.has(state.route);
    return guideRouteWithin(state.route, homeRoute);
  }

  function releaseQueuedResume(): void {
    clearRouteSettleTimer();
    host.setPending(null);
    host.setQueuedResumeLoading(false);
  }

  /**
   * Start the reserved tour once its home is the live route and the engine is
   * installed. Loading stays raised across that handoff so another guide cannot
   * start between preload and the route commit.
   */
  function commitPendingQueuedResume(): void {
    const pending = host.getPending();
    if (!pending) return;
    const { guide, homeRoute } = pending;
    if (!queuedResumeRouteOk(homeRoute) || host.guideRunning()) {
      releaseQueuedResume();
      return;
    }
    const loaded = host.getEngine();
    if (!loaded) return;
    clearRouteSettleTimer();
    host.setPending(null);
    host.runAuthoredProgram(loaded, guide);
    host.setQueuedResumeLoading(false);
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
    commitPendingQueuedResume();
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
      const stillThisResume = () => {
        if (host.loadGeneration() !== era) return false;
        const pending = host.getPending();
        return pending?.goalId === goalId && pending.homeRoute === homeRoute;
      };
      clearRouteSettleTimer();
      routeSettleTimer = setTimeout(() => {
        routeSettleTimer = null;
        if (!stillThisResume()) return;
        // Home committed: the route listener starts the tour. A miss here
        // means navigation never landed, so the reservation must not stick.
        if (queuedResumeRouteOk(homeRoute)) return;
        releaseQueuedResume();
      }, QUEUED_RESUME_ROUTE_SETTLE_MS);
      void host.ensureEngine().then((loaded) => {
        if (!stillThisResume()) return;
        if (!loaded) {
          releaseQueuedResume();
          host.notifyFailure(SUPPORT_ERROR_TEXT.AGENT_UNAVAILABLE);
          return;
        }
        // Route sync may still be in flight. Starting only when home is
        // already committed keeps loading raised until then, so another guide
        // cannot take the gap between preload and the route commit.
        if (!queuedResumeRouteOk(homeRoute)) return;
        commitPendingQueuedResume();
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
