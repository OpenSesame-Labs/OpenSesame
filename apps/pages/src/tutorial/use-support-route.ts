import { subscribeContributions } from "@opensesame/app-core/lib/contributions.js";
import { FIRST_VISIT_TOURS } from "@opensesame/app-core/tutorial/registry/first-visit.js";
import {
  GUIDE_OVERLAY_ROUTES,
  type GuideRouteId,
  guideRouteForLocation,
  guideRouteWithin,
} from "@opensesame/app-core/tutorial/registry/routes.js";
import { guideNavigationPath } from "@opensesame/app-core/tutorial/registry/vault-routes.js";
import { useEffect, useSyncExternalStore } from "react";
import { useLocation, useNavigate } from "react-router";
import type { SupportController } from "./session.js";

const githubSetupRoutes = Object.entries(FIRST_VISIT_TOURS)
  .filter(([, goals]) =>
    goals.some((goal) => goal === "connection.github.setup"),
  )
  .map(([route]) => route);

// Preserve GitHub setup context while its capability loads. This does not
// register a navigation destination or authorize its tour.
function contextRoute(pathname: string, search: string): GuideRouteId {
  const resolved = guideRouteForLocation(pathname, search);
  return githubSetupRoutes.reduce(
    (best, candidate) =>
      candidate.length > best.length && guideRouteWithin(pathname, candidate)
        ? candidate
        : best,
    resolved,
  );
}

/**
 * Keeps the support controller's idea of where the person is, and how a tour
 * moves them, in step with the router. The route is read to the precision a
 * tour needs — an item's pane and the trash are places of their own, though
 * neither is a path (`guideRouteForLocation`) — and a tour's `navigate` is
 * resolved the same way (`guideNavigationPath`). A gate screen is never
 * navigated to: it is declared by `useSupportRoute`, not entered by a tour.
 */
export function useSupportRouteSync(
  controller: SupportController,
  override: GuideRouteId | null,
): void {
  const location = useLocation();
  const navigate = useNavigate();
  const route = useSyncExternalStore(
    subscribeContributions,
    () => contextRoute(location.pathname, location.search),
    () => contextRoute(location.pathname, location.search),
  );

  useEffect(() => {
    controller.setRoute(override ?? route);
  }, [controller, override, route]);

  useEffect(() => {
    controller.setNavigator((route) => {
      if (GUIDE_OVERLAY_ROUTES.has(route)) return false;
      const path = guideNavigationPath(route, location);
      if (path === null) return false;
      navigate(path);
      return true;
    });
  }, [controller, navigate, location]);
}
