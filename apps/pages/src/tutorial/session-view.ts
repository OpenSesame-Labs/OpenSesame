import type { GuideRouteId } from "@opensesame/app-core/tutorial/registry/routes.js";
import type { SupportView } from "./session.js";

/** The panel before anything is asked: closed, and tours first. */
export function emptyView(route: GuideRouteId): SupportView {
  return {
    open: false,
    initialTab: "tutorials",
    ready: false,
    thinking: false,
    availability: null,
    transport: "none",
    warning: null,
    transcript: [],
    guide: null,
    route,
  };
}
