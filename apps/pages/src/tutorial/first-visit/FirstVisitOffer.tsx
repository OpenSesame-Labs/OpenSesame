/**
 * The first time a screen is met, its walkthrough is offered (ADR 0221).
 *
 * The library was always there, behind the question mark. A person who has
 * never seen the product does not know to press a question mark, so the
 * product now speaks first, once: on arriving at a screen whose tour this
 * device has not answered, a card names the tour and how long it is, with one
 * worded key that starts it and a dismiss that declines it. Either answer is
 * remembered (`lib/guidance.ts`) and the same tour is never offered again;
 * the library still lists it. A screen with more tours offers the next one
 * on a later session, one per session, until each has been answered.
 *
 * In `offer` mode the card takes no focus and dims nothing. Screens may place
 * it in their own flow; otherwise the shell or gate supplies a row. The offer
 * waits for that row if the screen is still mounting. It goes away when the
 * person moves on, opens Support or starts a tour. In `auto` mode, the default,
 * the tour starts itself instead; in `off` this component does nothing. It
 * rides in the support capability, so builds without guided help have no offer.
 */

import {
  anyDirtyEdit,
  hasDraftSaver,
} from "@opensesame/app-core/lib/dirty-edit.js";
import {
  noteScreenAnswered,
  rememberTourAnswered,
  screenAnsweredThisSession,
} from "@opensesame/app-core/lib/guidance.js";
import { firstVisitTour } from "@opensesame/app-core/tutorial/registry/first-visit.js";
import { guideRouteWithin } from "@opensesame/app-core/tutorial/registry/routes.js";
import {
  isMountedGuideTarget,
  subscribeToGuideTargets,
} from "@opensesame/app-core/tutorial/registry/targets.js";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useGuidance } from "../../lib/use-guidance.js";
import { gateIsPresent, subscribeGatePresence } from "../gate-presence.js";
import { useSupport } from "../session.js";
import { useTutorialGate } from "../ui/use-tutorial-gate.js";
import {
  FirstVisitInlineOffer,
  type InlineOffer,
} from "./FirstVisitInlineOffer.js";

export const firstVisitSeams = {
  /**
   * How long a screen has to stand before it speaks: long enough for a
   * redirect to settle and for a person passing through not to be stopped.
   */
  delayMs: 900,
  /** How often a waiting offer looks again for the sheet to have closed. */
  retryMs: 1000,
  /** A sheet or dialog owns the screen: an offer waits for it to close. */
  modalOpen: (): boolean =>
    document.querySelector('[aria-modal="true"], dialog[open]') !== null,
  /**
   * An editor is open, or something on the page is unsaved. A tour navigates
   * as it goes, and navigating away from an editor discards the draft, so a
   * screen does not speak until the edit is saved or closed.
   */
  editing: (): boolean => hasDraftSaver() || anyDirtyEdit(),
  /**
   * A script is driving this browser (WebDriver). Nobody is meeting the
   * screen for the first time, and a tour that starts itself dims the page
   * the script is about to press, so the default there is the offer, which
   * blocks nothing. A mode somebody chose is honoured either way.
   */
  driven: (): boolean => navigator.webdriver === true,
  /** The library's own gate: what is drawn, what holds, what is installed. */
  useGate: useTutorialGate,
};

const githubSetupReady = () =>
  isMountedGuideTarget("connections.github.method");

const NAVIGATE = /^\s*navigate\s+"([^"]+)"/gm;

/**
 * The screens a tour may be standing on by the time its first card is drawn:
 * the one it was started from, and every one it navigates to itself. A tour
 * found anywhere else was overtaken by the person, not by its own steps.
 */
export function tourScreens(start: string, guide: string): readonly string[] {
  return [start, ...[...guide.matchAll(NAVIGATE)].flatMap((m) => m[1] ?? [])];
}

type Asked = Readonly<{
  route: string;
  goal: string;
  screens: readonly string[];
}>;

/** The sentence under the tour's name. */
export function offerBody(steps: number): string {
  const length = steps === 1 ? "1 step" : `${steps} steps`;
  return `Follow ${length} to complete this task.`;
}

function compactOfferBody(steps: number): string {
  return offerBody(steps);
}

function bodyForOffer(offer: InlineOffer): string {
  return offer.host.dataset.firstVisitOffer === "gate" ||
    offer.host.dataset.firstVisitOffer === "shell" ||
    offer.host.closest(".gate-offer-frame") !== null
    ? compactOfferBody(offer.steps)
    : offerBody(offer.steps);
}

function offerHost(gateScreen: boolean): HTMLElement | null {
  if (gateScreen)
    return (
      document.querySelector<HTMLElement>(
        '.gate-offer-frame__body [data-first-visit-offer]:not([data-first-visit-offer="shell"]):not([data-first-visit-offer="gate"])',
      ) ??
      document.querySelector<HTMLElement>('[data-first-visit-offer="gate"]')
    );
  return (
    document.querySelector<HTMLElement>(
      '[data-first-visit-offer]:not([data-first-visit-offer="shell"]):not([data-first-visit-offer="gate"])',
    ) ?? document.querySelector<HTMLElement>('[data-first-visit-offer="shell"]')
  );
}

function usePendingFirstVisit(
  route: string,
  mode: string,
  running: string | null,
  support: ReturnType<typeof useSupport>["support"],
) {
  // A tour this component asked for that has not appeared yet. The engine is
  // fetched on first use, so on a cold load the person can have moved on by
  // the time it arrives; the answer is recorded, or the tour stopped, when
  // it does (below), never at the moment it was asked for.
  const asked = useRef<Asked | null>(null);
  useEffect(() => {
    const pending = asked.current;
    if (pending === null || running !== pending.goal) return;
    asked.current = null;
    const onItsScreens = pending.screens.some((screen) =>
      guideRouteWithin(route, screen),
    );
    if (!onItsScreens || mode !== "auto") {
      // It was started for a screen the person has left, or tours were
      // switched off meanwhile: it does not start over the wrong controls.
      // A tour's own first move (many begin by navigating) is not leaving.
      support.stopGuide();
      return;
    }
    noteScreenAnswered(pending.route);
    rememberTourAnswered(pending.goal);
  }, [running, route, mode, support]);
  return asked;
}

type Placement = {
  route: string;
  idle: boolean;
  mode: string;
  answered: ReadonlySet<string>;
  gate: ReturnType<typeof firstVisitSeams.useGate>;
  gateScreen: boolean;
  gatePresent: boolean;
  support: ReturnType<typeof useSupport>["support"];
  asked: { current: Asked | null };
  githubReady: boolean;
};

function useFirstVisitPlacement({
  route,
  idle,
  mode,
  answered,
  gate,
  gateScreen,
  gatePresent,
  support,
  asked,
  githubReady,
}: Placement) {
  const [inline, setInline] = useState<InlineOffer | null>(null);
  useEffect(() => {
    if (mode === "off" || !idle || (!gateScreen && gatePresent)) return;
    let timer: ReturnType<typeof setTimeout>;
    const speak = () => {
      // A sheet owns the screen, or an edit is under way: wait and ask again,
      // since neither ending changes anything this effect depends on.
      if (firstVisitSeams.modalOpen() || firstVisitSeams.editing()) {
        timer = setTimeout(speak, firstVisitSeams.retryMs);
        return;
      }
      if (screenAnsweredThisSession(route)) return;
      const tour = firstVisitTour(route, answered, gate);
      if (tour === null) return;
      const { goal, steps } = tour;
      if (goal.id === "connection.github.setup" && !githubReady) return;
      const answer = () => {
        noteScreenAnswered(route);
        rememberTourAnswered(goal.id);
      };
      const start = () => {
        answer();
        void support.startGuide(goal.guide, "authored");
      };
      if (mode === "auto") {
        if (asked.current !== null) return;
        const pending: Asked = {
          route,
          goal: goal.id,
          screens: tourScreens(route, goal.guide),
        };
        asked.current = pending;
        void support.startGuide(goal.guide, "authored").finally(() => {
          // Ended, or never began: nothing is owed to it any more.
          if (asked.current === pending) asked.current = null;
        });
        return;
      }
      const host = offerHost(gateScreen);
      if (
        !host ||
        (goal.id === "connection.github.setup" &&
          host.dataset.firstVisitOffer === "shell")
      ) {
        timer = setTimeout(speak, firstVisitSeams.retryMs);
        return;
      }
      setInline({
        host,
        route,
        title: goal.title,
        steps,
        start,
        dismiss: answer,
      });
    };
    timer = setTimeout(speak, firstVisitSeams.delayMs);
    return () => {
      clearTimeout(timer);
      // The screen it spoke about is gone, or a tour has begun.
      setInline((current) => (current?.route === route ? null : current));
    };
  }, [
    route,
    idle,
    mode,
    answered,
    gate,
    gateScreen,
    gatePresent,
    support,
    asked,
    githubReady,
  ]);
  return { inline, close: () => setInline(null) };
}

export function FirstVisitOffer({
  gateScreen = false,
}: {
  gateScreen?: boolean;
}) {
  const { view, support } = useSupport();
  const gate = firstVisitSeams.useGate();
  const guidance = useGuidance();
  const { route } = view;
  const githubReady = useSyncExternalStore(
    subscribeToGuideTargets,
    githubSetupReady,
    () => false,
  );
  const gatePresent = useSyncExternalStore(
    subscribeGatePresence,
    gateIsPresent,
    () => false,
  );
  const idle = !view.open && view.guide?.tour == null;
  const answered = useMemo(() => new Set(guidance.tours), [guidance.tours]);
  const mode =
    guidance.mode === "auto" && !guidance.chosen && firstVisitSeams.driven()
      ? "offer"
      : guidance.mode;
  const running = view.guide?.tour != null ? (view.guide?.goal ?? null) : null;
  const asked = usePendingFirstVisit(route, mode, running, support);

  const { inline, close } = useFirstVisitPlacement({
    route,
    idle,
    mode,
    answered,
    gate,
    gateScreen,
    gatePresent,
    support,
    asked,
    githubReady,
  });

  return inline && (gateScreen || !gatePresent) ? (
    <FirstVisitInlineOffer
      offer={inline}
      body={bodyForOffer(inline)}
      onClose={close}
    />
  ) : null;
}
