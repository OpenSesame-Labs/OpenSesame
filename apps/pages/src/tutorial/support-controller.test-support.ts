/**
 * A support controller that is only a view and a record of what was asked of
 * it. Test support: never imported by the app.
 *
 * A component that reads the controller through `SupportContext` — the
 * first-visit offer, the Guided tours row — needs a view it can change and a
 * way to see that a tour was started or the sheet opened. The real controller
 * loads an engine to do either; this one answers every member of the
 * interface and loads nothing.
 */

import type { GuideOrigin } from "./engine.js";
import type { SupportController, SupportTab, SupportView } from "./session.js";
import { emptyView } from "./session-view.js";

export type StartedGuide = Readonly<{
  source: string;
  origin: GuideOrigin | undefined;
}>;

export function stubSupportController(
  route: string,
  initial: Partial<SupportView> = {},
) {
  let view: SupportView = { ...emptyView(route), ...initial };
  const listeners = new Set<() => void>();
  const started: StartedGuide[] = [];
  const opened: (SupportTab | undefined)[] = [];
  const stops = { count: 0 };
  const nothing = () => undefined;
  const support: SupportController = {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    view: () => view,
    open: (tab) => {
      opened.push(tab);
    },
    close: nothing,
    setRoute: nothing,
    setNavigator: nothing,
    ask: () => Promise.resolve(),
    cancel: nothing,
    clear: nothing,
    acquireModel: () => Promise.resolve(),
    answerFromAuthoredHelp: nothing,
    startGuide: (source, origin) => {
      started.push({ source, origin });
      // A tour runs until the person ends it; the suite ends first.
      return new Promise<void>(() => undefined);
    },
    pauseGuide: nothing,
    nextStep: nothing,
    backStep: nothing,
    replayGuide: nothing,
    stopGuide: () => {
      stops.count += 1;
    },
    lock: nothing,
    destroy: nothing,
  };
  return {
    support,
    /** Every tour the component started, in order. */
    started,
    /** Every tab the component opened the sheet on, in order. */
    opened,
    /** How many times the component left a tour. */
    stops,
    /** Change the view and tell the component, as the controller would. */
    set(patch: Partial<SupportView>): void {
      view = { ...view, ...patch };
      for (const listener of [...listeners]) listener();
    },
  };
}
