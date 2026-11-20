import {
  HELP_TOPICS,
  guideGoal,
} from "@opensesame/app-core/tutorial/registry/goals.js";
import type { GuideRouteId } from "@opensesame/app-core/tutorial/registry/routes.js";
import { webmcpSupportSeam } from "@opensesame/app-core/webmcp/tool-shared.js";
import {
  type ReactElement,
  type ReactNode,
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { useVault } from "../lib/vault/hooks.js";
import {
  type SupportController,
  type SupportView,
  createSupportController,
  supportSessionSeams,
} from "./session.js";
import { SupportContext } from "./support-context.js";
import { useSupportRouteSync } from "./use-support-route.js";

export const SupportRouteOverrideContext = createContext<
  (route: GuideRouteId | null) => void
>(() => {});

/**
 * Screens that are not a URL — unlock, setup, the broker popup — declare
 * themselves so page context names the ceremony the person is actually in,
 * not the path the router still holds.
 */
export function useSupportRoute(route: GuideRouteId): void {
  const setOverride = useContext(SupportRouteOverrideContext);
  useEffect(() => {
    setOverride(route);
    return () => setOverride(null);
  }, [route, setOverride]);
}

/**
 * Written with `createElement` rather than JSX so the composition root stays a
 * `.ts` file: it wires the feature together, it does not draw anything.
 */
export function SupportProvider({
  children,
}: {
  children?: ReactNode;
}): ReactElement {
  const [controller] = useState(() =>
    createSupportController(supportSessionSeams),
  );
  const [override, setOverride] = useState<GuideRouteId | null>(null);
  const setRouteOverride = useCallback((route: GuideRouteId | null) => {
    setOverride(route);
  }, []);

  useEffect(() => () => controller.destroy(), [controller]);

  useEffect(
    () => supportSessionSeams.onLock(() => controller.lock()),
    [controller],
  );

  useEffect(
    () =>
      controller.bindTutorialResume((goalId, guide, homeRoute) =>
        controller.resumeQueuedWalkthrough(goalId, guide, homeRoute),
      ),
    [controller],
  );

  useSupportRouteSync(controller, override);

  const { status: vaultStatus } = useVault();
  useEffect(() => {
    if (vaultStatus !== "unlocked") return;
    const previous = { ...webmcpSupportSeam };
    Object.assign(webmcpSupportSeam, {
      openSupport: (topic: string | null) => {
        controller.open(topic ? "ask" : undefined);
        const authored = HELP_TOPICS.find((entry) => entry.id === topic);
        if (authored) {
          controller.answerFromAuthoredHelp(authored.title, authored.answer);
        }
      },
      startGuide: (goal: string) => {
        const named = guideGoal(goal);
        if (named) void controller.startGuide(named.guide, "authored");
      },
    });
    return () => {
      Object.assign(webmcpSupportSeam, previous);
    };
  }, [controller, vaultStatus]);

  return createElement(
    SupportRouteOverrideContext.Provider,
    { value: setRouteOverride },
    createElement(SupportContext.Provider, { value: controller }, children),
  );
}

export type SupportAccess = {
  readonly view: SupportView;
  readonly support: SupportController;
};

export function useSupport(): SupportAccess {
  const controller = useContext(SupportContext);
  if (!controller) throw new Error("support_provider_missing");
  const view = useSyncExternalStore(controller.subscribe, controller.view);
  return { view, support: controller };
}
