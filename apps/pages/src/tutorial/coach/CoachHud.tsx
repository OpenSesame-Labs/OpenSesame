/**
 * Tutorial mode: the page dims, one control stays lit, and a card walks you
 * through it a step at a time.
 *
 * The runtime publishes every step as data — its text, the control it points
 * at, which side the author preferred, whether doing the thing also advances —
 * and this component only draws it. Everything a model or an author wrote
 * reaches the page as a React text node; nothing here parses markup, and a
 * control is found only through the target registry's own resolver (ADR 0088).
 *
 * It is not a modal. The page stays interactive through the aperture so a
 * step can say "your move" and mean it, the dim blocks nothing but stray
 * clicks, and Tab still leaves the card for the page. What it owns is the
 * keys that belong to a tour: Escape leaves it, and the arrow keys step it
 * while the caret is in the card.
 */

import { guideGoal } from "@opensesame/app-core/tutorial/registry/goals.js";
import type {
  GuideRuntimeSnapshot,
  GuideTourView,
} from "@opensesame/guide-runtime";
import {
  type CSSProperties,
  type ReactElement,
  type RefObject,
  useId,
  useRef,
} from "react";
import { type SupportController, useSupport } from "../session.js";
import "./coach.css";
import {
  CLOSING_TEXT,
  Dim,
  Foot,
  Head,
  Meter,
  Ring,
  counterOf,
} from "./CoachParts.js";
import { CONSTRAINED_CARD_HEIGHT, type placeCoach } from "./placement.js";
import {
  cardKeys,
  useCoachFocus,
  useEscapeToExit,
} from "./use-coach-behavior.js";
import { useCoachLayout } from "./use-coach-layout.js";

/** The notch's offset along the card edge, as the custom property coach.css reads. */
function notchStyle(px: number): CSSProperties & { "--coach-notch": string } {
  return { "--coach-notch": `${px}px` };
}

/** Where the card sits, as the inline style and classes the placement needs. */
type CardStyle = { readonly style: CSSProperties; readonly dock: string };

function cardStyle(placement: ReturnType<typeof placeCoach> | null): CardStyle {
  if (placement === null) return { style: { visibility: "hidden" }, dock: "" };
  if (placement.kind === "dock") {
    return { style: {}, dock: `coach__card--dock-${placement.edge}` };
  }
  return { style: { left: placement.left, top: placement.top }, dock: "" };
}

function titleOf(guide: GuideRuntimeSnapshot): string {
  return (guide.goal ? guideGoal(guide.goal)?.title : undefined) ?? "Tutorial";
}

function displayedTour(
  tour: GuideTourView,
  firstVault: boolean,
  requiredAction: boolean,
  ready: boolean,
): GuideTourView {
  const gateTarget =
    tour.target?.startsWith("unlock.") || tour.target === "setup.default";
  const offset = firstVault
    ? tour.count === 8 && !gateTarget
      ? 8
      : tour.count === 6
        ? 2
        : 0
    : 0;
  let message = tour.message;
  if (requiredAction && ready && !tour.action) {
    if (tour.target === "editor.password-options")
      message = "Password options are open. Select Next.";
    else if (tour.target === "editor.pepper")
      message = "Pepper is off. Select Next.";
    else if (tour.target === "unlock.seal-pin")
      message = "PIN is selected. Select Next.";
  }
  return {
    ...tour,
    message,
    step: tour.step + offset,
    count: firstVault ? 16 : tour.count,
  };
}

/** Back is safe within the current PIN form or item editor. */
function canReturn(guide: GuideRuntimeSnapshot, tour: GuideTourView): boolean {
  if (!tour.canBack) return false;
  if (guide.goal === "gate.front-door") {
    if (
      ["unlock.seal-pin-confirm", "unlock.seal-ack", "unlock.seal"].includes(
        tour.target ?? "",
      )
    )
      return true;
    return (
      tour.count === 8 &&
      [
        "editor.password-options",
        "editor.pepper",
        "editor.generate-password",
        "item.editor.save",
      ].includes(tour.target ?? "")
    );
  }
  if (guide.goal === "vault.item.first") {
    return !["item.editor.name", "item.copy-password"].includes(
      tour.target ?? "",
    );
  }
  return true;
}

function viewportDockStyle(
  placement: ReturnType<typeof placeCoach> | null,
  viewport: {
    width: number;
    offsetLeft: number;
    rightOffset: number;
    offsetTop: number;
    bottomOffset: number;
  },
): CSSProperties {
  if (placement?.kind !== "dock") {
    return { maxWidth: `calc(${viewport.width}px - 1.5rem)` };
  }
  const horizontal = {
    left: `calc(0.5rem + ${viewport.offsetLeft}px)`,
    right: `calc(0.5rem + ${viewport.rightOffset}px)`,
  };
  if (placement.edge === "top") {
    return {
      ...horizontal,
      top: `calc(0.5rem + env(safe-area-inset-top, 0px) + ${viewport.offsetTop}px)`,
    };
  }
  return {
    ...horizontal,
    bottom: `calc(0.5rem + env(safe-area-inset-bottom, 0px) + ${viewport.bottomOffset}px)`,
  };
}

/** The sentence, announced with its position for a listener who never sees the meter. */
function Narration({
  id,
  tour,
  counter,
  compactMissing,
}: {
  id: string;
  tour: GuideTourView;
  counter: string;
  compactMissing: boolean;
}): ReactElement {
  const closing = tour.kind === "close";
  return (
    <p className="coach__text" id={id} aria-live="polite">
      {counter && !closing ? (
        <span className="visually-hidden">{counter}. </span>
      ) : null}
      {tour.message ?? (closing ? CLOSING_TEXT : "")}
      {compactMissing ? " Control not on screen." : null}
    </p>
  );
}

type CardPresentation = {
  firstVault: boolean;
  requiredAction: boolean;
  ready: boolean;
  canBack: boolean;
  displayTour: GuideTourView;
  constrained: boolean;
  awaitingAction: boolean;
  compactRow: boolean;
};

function cardClassName(
  dock: string,
  kind: GuideTourView["kind"],
  placed: boolean,
  view: CardPresentation,
): string {
  return [
    "coach__card",
    dock,
    `coach__card--${kind}`,
    view.constrained && "coach__card--constrained",
    view.awaitingAction && "coach__card--awaiting-action",
    view.compactRow && "coach__card--compact-row",
    placed && "is-placed",
  ]
    .filter(Boolean)
    .join(" ");
}

function CoachCard({
  guide,
  tour,
  support,
  layout,
  view,
  cardRef,
  primaryRef,
}: {
  guide: GuideRuntimeSnapshot;
  tour: GuideTourView;
  support: SupportController;
  layout: ReturnType<typeof useCoachLayout>;
  view: CardPresentation;
  cardRef: RefObject<HTMLElement | null>;
  primaryRef: RefObject<HTMLButtonElement | null>;
}): ReactElement {
  const titleId = useId();
  const bodyId = useId();
  const closing = tour.kind === "close";
  const title = titleOf(guide);
  const { viewport, placement, missing, maxHeight } = layout;
  const {
    displayTour,
    constrained,
    awaitingAction,
    ready,
    canBack,
    requiredAction,
    firstVault,
  } = view;
  const { style, dock } = cardStyle(placement);
  const viewportDock = viewportDockStyle(placement, viewport);
  const facing = placement?.kind === "anchored" ? placement.facing : undefined;
  const notch = placement?.kind === "anchored" ? placement.notch : 0;
  const counter = counterOf(displayTour);

  return (
    <section
      ref={cardRef}
      className={cardClassName(dock, tour.kind, placement !== null, view)}
      style={{
        ...style,
        ...viewportDock,
        maxHeight,
        minHeight: awaitingAction ? Math.min(maxHeight ?? 52, 52) : undefined,
      }}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      data-facing={facing}
      onKeyDown={cardKeys(
        support,
        ready && canBack,
        ready && (!requiredAction || !tour.action),
      )}
    >
      {facing !== undefined ? (
        <span
          className="coach__notch"
          style={notchStyle(notch)}
          aria-hidden="true"
        />
      ) : null}
      <Meter tour={displayTour} />
      <Head
        titleId={titleId}
        title={title}
        counter={counter}
        closing={closing}
        support={support}
      />
      <Narration
        id={bodyId}
        tour={displayTour}
        counter={counter}
        compactMissing={constrained && missing}
      />
      <Foot
        tour={tour}
        missing={missing}
        support={support}
        primary={primaryRef}
        firstVault={firstVault}
        canBack={canBack}
        requiredAction={requiredAction}
        ready={ready}
      />
    </section>
  );
}

function Coach({
  guide,
  tour,
  support,
}: {
  guide: GuideRuntimeSnapshot;
  tour: GuideTourView;
  support: SupportController;
}): ReactElement {
  const cardRef = useRef<HTMLElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const firstVault = guide.goal === "gate.front-door";
  const requiredAction = firstVault || guide.goal === "vault.item.first";
  const ready = guide.status === "waiting";
  const canBack = canReturn(guide, tour);
  const layout = useCoachLayout(guide.runId, tour, cardRef);
  const { stepKey, viewport, hole, placement, gliding, missing, maxHeight } =
    layout;
  const constrained =
    maxHeight !== undefined && maxHeight < CONSTRAINED_CARD_HEIGHT;
  const awaitingAction =
    constrained && requiredAction && tour.action && !missing && !canBack;
  const compactRow =
    constrained && !awaitingAction && maxHeight !== undefined && maxHeight < 90;
  useCoachFocus(
    placement !== null,
    stepKey,
    cardRef,
    primaryRef,
    awaitingAction,
  );
  useEscapeToExit(support);
  const view: CardPresentation = {
    firstVault,
    requiredAction,
    ready,
    canBack,
    displayTour: displayedTour(tour, firstVault, requiredAction, ready),
    constrained,
    awaitingAction,
    compactRow,
  };
  return (
    <div
      className="coach"
      data-coach-step={tour.step}
      data-coach-kind={tour.kind}
      data-coach-status={guide.status}
      data-coach-target={tour.target ?? ""}
      data-coach-degraded={missing ? "true" : "false"}
    >
      <Dim hole={hole} viewport={viewport} gliding={gliding} />
      {hole !== null ? (
        <Ring hole={hole} gliding={gliding} action={tour.action} />
      ) : null}
      <CoachCard
        guide={guide}
        tour={tour}
        support={support}
        layout={layout}
        view={view}
        cardRef={cardRef}
        primaryRef={primaryRef}
      />
    </div>
  );
}

/**
 * Draws the tour the runtime is on, or nothing. Keyed by run, so Replay from
 * the panel (a new run) re-enters from the first step with the entrance.
 */
export function CoachHud(): ReactElement | null {
  const { view, support } = useSupport();
  const guide = view.guide;
  const tour = guide?.tour ?? null;
  if (!guide || !tour) return null;
  return (
    <Coach key={guide.runId} guide={guide} tour={tour} support={support} />
  );
}
