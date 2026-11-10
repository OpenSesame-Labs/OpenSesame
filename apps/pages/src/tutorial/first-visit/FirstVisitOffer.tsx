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
 * tour some other way. In `auto` mode the tour starts itself instead of
 * being offered; in `off` this component does nothing.
 *
 * It draws nothing of its own and rides in the support capability, so a
 * build without guided help has no offers either.
 */

import { rememberTourAnswered } from "@opensesame/app-core/lib/guidance.js";
import { hideToast, showToast } from "@opensesame/app-core/lib/notice-toast.js";
import { firstVisitTour } from "@opensesame/app-core/tutorial/registry/first-visit.js";
import { useEffect, useMemo } from "react";
import { useGuidance } from "../../lib/use-guidance.js";
import { useSupport } from "../session.js";
import { useTutorialGate } from "../ui/use-tutorial-gate.js";

export const firstVisitSeams = {
  /**
   * How long a screen has to stand before it speaks: long enough for a
   * redirect to settle and for a person passing through not to be stopped.
   */
  delayMs: 900,
  /** A sheet or dialog owns the screen: an offer waits for it to close. */
  modalOpen: (): boolean =>
    document.querySelector('[aria-modal="true"], dialog[open]') !== null,
  /** The library's own gate: what is drawn, what holds, what is installed. */
  useGate: useTutorialGate,
  /**
   * The screens that already had an offer answered since the page loaded. A
   * screen with several tours offers one of them per session, so coming back
   * to it is not met with the next card each time.
   */
  answeredThisSession: new Set<string>(),
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
  const { mode } = guidance;

  useEffect(() => {
    if (mode === "off" || !idle) return;
    let shown: string | null = null;
    const timer = setTimeout(() => {
      if (firstVisitSeams.modalOpen()) return;
      if (firstVisitSeams.answeredThisSession.has(route)) return;
      const tour = firstVisitTour(route, answered, gate);
      if (tour === null) return;
      const { goal, steps } = tour;
      const answer = () => {
        firstVisitSeams.answeredThisSession.add(route);
        rememberTourAnswered(goal.id);
      };
      const start = () => {
        answer();
        void support.startGuide(goal.guide, "authored");
      };
      if (mode === "auto") {
        start();
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
    }, firstVisitSeams.delayMs);
    return () => {
      clearTimeout(timer);
      // The screen it spoke about is gone, or a tour has begun.
      if (shown !== null) hideToast(shown);
    };
  }, [route, idle, mode, answered, gate, support]);

  return null;
}
