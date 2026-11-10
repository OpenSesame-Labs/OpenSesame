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
 * The card is a toast, not a modal: it takes no focus, dims nothing and
 * blocks no control, so a person who already knows the screen simply carries
 * on. It is taken back when they move on, open the Support sheet or start a
 * tour some other way. That is `offer` mode. In `auto` mode, the default,
 * the tour starts itself instead; in `off` this component does nothing.
 *
 * It draws nothing of its own and rides in the support capability, so a
 * build without guided help has no offers either.
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
import { hideToast, showToast } from "@opensesame/app-core/lib/notice-toast.js";
import { firstVisitTour } from "@opensesame/app-core/tutorial/registry/first-visit.js";
import { useEffect, useMemo, useRef } from "react";
import { useGuidance } from "../../lib/use-guidance.js";
import { useSupport } from "../session.js";
import { useTutorialGate } from "../ui/use-tutorial-gate.js";

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

const offerId = (goal: string) => `first-visit:${goal}`;

/** The sentence under the tour's name. */
export function offerBody(steps: number): string {
  const length = steps === 1 ? "1 step" : `${steps} steps`;
  return `New here? This walkthrough takes ${length}, on the real controls. It only points — nothing changes unless you do it.`;
}

export function FirstVisitOffer(): null {
  const { view, support } = useSupport();
  const gate = firstVisitSeams.useGate();
  const guidance = useGuidance();
  const { route } = view;
  const idle = !view.open && view.guide?.tour == null;
  const answered = useMemo(() => new Set(guidance.tours), [guidance.tours]);
  const mode =
    guidance.mode === "auto" && !guidance.chosen && firstVisitSeams.driven()
      ? "offer"
      : guidance.mode;

  // A tour this component asked for that has not appeared yet. The engine is
  // fetched on first use, so on a cold load the person can have moved on by
  // the time it arrives; the answer is recorded, or the tour stopped, when
  // it does (below), never at the moment it was asked for.
  const asked = useRef<{ route: string; goal: string } | null>(null);
  const running = view.guide?.tour != null ? (view.guide?.goal ?? null) : null;
  useEffect(() => {
    const pending = asked.current;
    if (pending === null || running !== pending.goal) return;
    asked.current = null;
    if (pending.route !== route || mode !== "auto") {
      // It was started for a screen the person has left, or tours were
      // switched off meanwhile: it does not start over the wrong controls.
      support.stopGuide();
      return;
    }
    noteScreenAnswered(pending.route);
    rememberTourAnswered(pending.goal);
  }, [running, route, mode, support]);

  useEffect(() => {
    if (mode === "off" || !idle) return;
    let shown: string | null = null;
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
        const pending = { route, goal: goal.id };
        asked.current = pending;
        void support.startGuide(goal.guide, "authored").finally(() => {
          // Ended, or never began: nothing is owed to it any more.
          if (asked.current === pending) asked.current = null;
        });
        return;
      }
      shown = offerId(goal.id);
      showToast({
        id: shown,
        tone: "info",
        title: goal.title,
        body: offerBody(steps),
        sticky: true,
        choice: { label: "Show me", run: start },
        onDismiss: answer,
      });
    };
    timer = setTimeout(speak, firstVisitSeams.delayMs);
    return () => {
      clearTimeout(timer);
      // The screen it spoke about is gone, or a tour has begun.
      if (shown !== null) hideToast(shown);
    };
  }, [route, idle, mode, answered, gate, support]);

  return null;
}
