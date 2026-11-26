import {
  resolveGuideTargetElement,
  subscribeToGuideTargets,
} from "@opensesame/app-core/tutorial/registry/targets.js";
import type { GuideTourView } from "@opensesame/guide-runtime";
import { type RefObject, useCallback, useSyncExternalStore } from "react";
import { padded } from "./CoachParts.js";
import {
  type Box,
  CONSTRAINED_CARD_HEIGHT,
  NARROW_VIEWPORT_WIDTH,
  SHORT_VIEWPORT_HEIGHT,
  clearOfDock,
  phoneCardHeightLimit,
  placeCoach,
} from "./placement.js";
import { useGlide } from "./use-coach-behavior.js";
import {
  useLiveRect,
  useMeasured,
  usePhoneLayout,
  useSafeInsets,
  useViewport,
} from "./use-geometry.js";

function recoverySnapshot(): "edit" | "options" | "pepper" | "" {
  const save = resolveGuideTargetElement("item.editor.save");
  if (save) {
    if (save.getAttribute("data-guide-pepper-recovery") !== "save") return "";
    return resolveGuideTargetElement("editor.pepper-options")
      ? "pepper"
      : "options";
  }
  const edit = resolveGuideTargetElement("item.edit");
  return edit?.getAttribute("data-guide-pepper-recovery") === "edit"
    ? "edit"
    : "";
}

function copyRecoverySnapshot() {
  return (
    recoverySnapshot() ||
    (resolveGuideTargetElement("item.editor.save") ? ("save" as const) : "")
  );
}

function generationRecoverySnapshot(): "options" | "pepper" | "" {
  const generate = resolveGuideTargetElement("editor.generate-password");
  if (generate?.getAttribute("data-guide-pepper-recovery") !== "generate")
    return "";
  return resolveGuideTargetElement("editor.pepper-options")
    ? "pepper"
    : "options";
}

function subscribeRecovery(listener: () => void): () => void {
  const observer = new MutationObserver(listener);
  // A target can mount while hidden and become pointable without a new ref.
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-guide-pepper-recovery"],
    subtree: true,
  });
  const unsubscribe = subscribeToGuideTargets(listener);
  return () => {
    unsubscribe();
    observer.disconnect();
  };
}

const noRecovery = () => "" as const;
const noSubscription = () => () => {};
const RECOVERY_TARGETS = {
  edit: "item.edit",
  options: "editor.password-options",
  pepper: "editor.pepper-options",
  save: "item.editor.save",
} as const;

function useRecoveryTarget(tour: GuideTourView, firstPassword: boolean) {
  const saving = firstPassword && tour.target === "item.editor.save";
  const copying = firstPassword && tour.target === "item.copy-generated";
  const generating =
    firstPassword && tour.target === "editor.generate-password";
  const recovery = useSyncExternalStore(
    saving || copying || generating ? subscribeRecovery : noSubscription,
    saving
      ? recoverySnapshot
      : copying
        ? copyRecoverySnapshot
        : generating
          ? generationRecoverySnapshot
          : noRecovery,
    noRecovery,
  );
  return {
    recovery,
    target: recovery ? RECOVERY_TARGETS[recovery] : tour.target,
  };
}

function visibleTarget(
  target: GuideTourView["target"],
  original: GuideTourView["target"],
  degraded: boolean,
): HTMLElement | null {
  if (target === null || (degraded && target === original)) return null;
  return resolveGuideTargetElement(target);
}

function missingTarget(
  target: GuideTourView["target"],
  tour: GuideTourView,
  rect: Box | null,
): boolean {
  return (
    target !== null &&
    ((tour.degraded && target === tour.target) || rect === null)
  );
}

/** At high zoom the ring may meet the card edge, but the target stays clear. */
function targetForPlacement(
  rect: Box | null,
  paddedRect: Box | null,
  viewport: {
    width: number;
    height: number;
    offsetLeft: number;
    offsetTop: number;
  },
): Box | null {
  if (
    rect === null ||
    viewport.width >= NARROW_VIEWPORT_WIDTH ||
    viewport.height >= SHORT_VIEWPORT_HEIGHT
  )
    return paddedRect;
  return {
    ...rect,
    left: rect.left - viewport.offsetLeft,
    top: rect.top - viewport.offsetTop,
  };
}

function sizeFlags(
  viewport: { width: number; height: number; scale: number },
  maxHeight: number | undefined,
) {
  const narrow = viewport.width < NARROW_VIEWPORT_WIDTH;
  return {
    narrow,
    short:
      narrow && viewport.height < SHORT_VIEWPORT_HEIGHT && viewport.scale > 1,
    constrained:
      narrow ||
      (maxHeight !== undefined && maxHeight < CONSTRAINED_CARD_HEIGHT),
  };
}

type ViewportFrame = { offsetLeft: number; offsetTop: number };

/**
 * One coordinate space per consumer, with the conversions between them
 * named. `visibleTargetRect` and `getBoundingClientRect` report in the
 * layout viewport's client coordinates — the space `elementsFromPoint` and
 * pointer `clientX`/`clientY` use, so the uncovered probe and the measured
 * rect can never disagree. `placeCoach` works in the visual viewport's
 * frame (its viewport is the visual size), so a target rect crosses in
 * through `toVisualFrame`. The card, ring and dim are `position: fixed`,
 * which positions against the layout viewport, so every placement crosses
 * back out through `toLayoutFrame`. With no pinch zoom the visual viewport
 * sits at the layout viewport's origin, the offsets are zero and both
 * directions are the identity.
 */
function toVisualFrame<T extends { left: number; top: number }>(
  box: T,
  viewport: ViewportFrame,
): T {
  return {
    ...box,
    left: box.left - viewport.offsetLeft,
    top: box.top - viewport.offsetTop,
  };
}

function toLayoutFrame<T extends { left: number; top: number }>(
  box: T,
  viewport: ViewportFrame,
): T {
  return {
    ...box,
    left: box.left + viewport.offsetLeft,
    top: box.top + viewport.offsetTop,
  };
}

/**
 * Where everything goes for one step: the aperture around the lit control,
 * the card beside it, and whether the control is there at all. Pure
 * arithmetic over what the page reports each frame.
 */
export function useCoachLayout(
  runId: number,
  tour: GuideTourView,
  card: RefObject<HTMLElement | null>,
  firstPassword: boolean,
) {
  const { recovery, target } = useRecoveryTarget(tour, firstPassword);
  const stepKey = `${runId}:${tour.kind}:${tour.step}:${target ?? ""}`;
  const rect = useLiveRect(
    useCallback(
      () => visibleTarget(target, tour.target, tour.degraded),
      [target, tour.degraded, tour.target],
    ),
    stepKey,
  );
  const viewport = useViewport();
  const phone = usePhoneLayout();
  const insets = useSafeInsets();
  const size = useMeasured(card, `${stepKey}:${tour.message}:${phone}`);
  const box = rect === null ? null : padded(rect);
  // Cross into the visual viewport's frame for placement (see toVisualFrame).
  const relativeBox = box === null ? null : toVisualFrame(box, viewport);
  const placementBox = targetForPlacement(rect, relativeBox, viewport);
  const relativePlacement =
    size === null
      ? null
      : placeCoach({
          viewport,
          card: size,
          target: placementBox,
          prefer: tour.side,
          phone,
          insets,
        });
  // Cross back out for the fixed-positioned card (see toLayoutFrame). A
  // docked card is placed by the CSS offsets in `viewportDockStyle`, which
  // already carry the visual viewport's frame, so it does not shift here.
  const placement =
    relativePlacement && relativePlacement.kind !== "dock"
      ? toLayoutFrame(relativePlacement, viewport)
      : relativePlacement;
  const relativeHole =
    relativeBox !== null && size !== null && placement?.kind === "dock"
      ? clearOfDock(relativeBox, viewport, size, placement.edge, insets)
      : relativeBox;
  // The ring and the dim panels are fixed-positioned too: back to layout
  // frame, where the measured rect and the probe coordinates already are.
  const hole =
    relativeHole === null ? null : toLayoutFrame(relativeHole, viewport);
  const maxHeight = phone
    ? phoneCardHeightLimit(viewport, placementBox, insets)
    : undefined;
  return {
    stepKey,
    target,
    recovery,
    viewport,
    hole,
    placement,
    maxHeight,
    ...sizeFlags(viewport, maxHeight),
    gliding: useGlide(stepKey),
    // A control that was on screen and is gone — the person navigated away —
    // is the same situation as one that never appeared.
    missing: missingTarget(target, tour, rect),
  };
}
