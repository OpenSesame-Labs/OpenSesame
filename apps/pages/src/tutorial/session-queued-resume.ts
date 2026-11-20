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

type RouteSettle = {
  timer: ReturnType<typeof setTimeout> | null;
};

function clearRouteSettleTimer(settle: RouteSettle): void {
  if (settle.timer === null) return;
  clearTimeout(settle.timer);
  settle.timer = null;
}

function homeIsCurrent(host: QueuedResumeHost, homeRoute: string): boolean {
  const state = host.getState();
  if (homeRoute === "") return !GUIDE_OVERLAY_ROUTES.has(state.route);
  return guideRouteWithin(state.route, homeRoute);
}

function releaseReservation(host: QueuedResumeHost, settle: RouteSettle): void {
  clearRouteSettleTimer(settle);
  host.setPending(null);
  host.setQueuedResumeLoading(false);
}

/**
 * Start the reserved tour once its home is the live route and the engine is
 * installed. A route that is not home yet, or a guide already running, drops
 * the reservation so a later unrelated visit cannot start the stale tour.
 */
function commitReservedResume(
  host: QueuedResumeHost,
  settle: RouteSettle,
): void {
  const pending = host.getPending();
  if (!pending) return;
  const { guide, homeRoute } = pending;
  if (!homeIsCurrent(host, homeRoute) || host.guideRunning()) {
    releaseReservation(host, settle);
    return;
  }
  const loaded = host.getEngine();
  if (!loaded) return;
  clearRouteSettleTimer(settle);
  host.setPending(null);
  host.runAuthoredProgram(loaded, guide);
  host.setQueuedResumeLoading(false);
}

function beginOnHome(
  host: QueuedResumeHost,
  guide: string,
  homeRoute: string,
): boolean {
  if (host.guideRunning() || host.queuedResumeLoading()) return false;
  if (!homeIsCurrent(host, homeRoute)) return false;
  const beginAuthored = (loaded: SupportEngine) => {
    if (host.guideRunning()) return false;
    if (!homeIsCurrent(host, homeRoute)) return false;
    return host.runAuthoredProgram(loaded, guide);
  };
  const engine = host.getEngine();
  if (engine) return beginAuthored(engine);
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
      if (host.loadGeneration() === era) host.setQueuedResumeLoading(false);
    });
  return true;
}

function pendingIsThisResume(
  host: QueuedResumeHost,
  era: number,
  goalId: string,
  homeRoute: string,
): boolean {
  if (host.loadGeneration() !== era) return false;
  const pending = host.getPending();
  return pending?.goalId === goalId && pending.homeRoute === homeRoute;
}

/**
 * Hold loading from preload until the route commits. The settle timer is the
 * only abandon path while the route is still the origin; a miss after
 * `QUEUED_RESUME_ROUTE_SETTLE_MS` means home never landed.
 */
function reserveOffRoute(
  host: QueuedResumeHost,
  settle: RouteSettle,
  goalId: string,
  guide: string,
  homeRoute: string,
): void {
  host.setQueuedResumeLoading(true);
  host.setPending({ goalId, guide, homeRoute });
  const era = host.loadGeneration();
  const stillThisResume = () =>
    pendingIsThisResume(host, era, goalId, homeRoute);
  clearRouteSettleTimer(settle);
  settle.timer = setTimeout(() => {
    settle.timer = null;
    if (!stillThisResume()) return;
    if (homeIsCurrent(host, homeRoute)) return;
    releaseReservation(host, settle);
  }, QUEUED_RESUME_ROUTE_SETTLE_MS);
  void host.ensureEngine().then((loaded) => {
    if (!stillThisResume()) return;
    if (!loaded) {
      releaseReservation(host, settle);
      host.notifyFailure(SUPPORT_ERROR_TEXT.AGENT_UNAVAILABLE);
      return;
    }
    // Route sync may still be in flight. Starting only when home is already
    // committed keeps loading raised, so another guide cannot take the gap.
    if (!homeIsCurrent(host, homeRoute)) return;
    commitReservedResume(host, settle);
  });
}

function resumeQueued(
  host: QueuedResumeHost,
  settle: RouteSettle,
  goalId: string,
  guide: string,
  homeRoute: string,
): boolean {
  if (guideGoal(goalId) === null) return false;
  if (GUIDE_OVERLAY_ROUTES.has(homeRoute)) return false;
  if (host.guideRunning() || host.queuedResumeLoading()) return false;
  if (!homeIsCurrent(host, homeRoute)) {
    if (!host.getNavigator()?.(homeRoute)) return false;
    reserveOffRoute(host, settle, goalId, guide, homeRoute);
    return true;
  }
  return beginOnHome(host, guide, homeRoute);
}

export function createQueuedResumeHandlers(host: QueuedResumeHost) {
  const settle: RouteSettle = { timer: null };
  return {
    queuedResumeRouteOk: (homeRoute: string) => homeIsCurrent(host, homeRoute),
    beginQueuedWalkthrough: (guide: string, homeRoute: string) =>
      beginOnHome(host, guide, homeRoute),
    flushPendingQueuedResume: () => commitReservedResume(host, settle),
    resumeQueuedWalkthrough: (
      goalId: string,
      guide: string,
      homeRoute: string,
    ) => resumeQueued(host, settle, goalId, guide, homeRoute),
  };
}
