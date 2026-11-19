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
  const refresh = () => {
    observer.disconnect();
    for (const id of [
      "item.editor.save",
      "item.edit",
      "editor.generate-password",
    ] as const) {
      const node = resolveGuideTargetElement(id);
      if (node)
        observer.observe(node, {
          attributes: true,
          attributeFilter: ["data-guide-pepper-recovery"],
        });
    }
    listener();
  };
  const unsubscribe = subscribeToGuideTargets(refresh);
  refresh();
  return () => {
    unsubscribe();
    observer.disconnect();
  };
}

const noRecovery = () => "" as const;
const noSubscription = () => () => {};
const notBlocked = () => false;
const RECOVERY_TARGETS = {
  edit: "item.edit",
  options: "editor.password-options",
  pepper: "editor.pepper-options",
} as const;

function useRecoveryTarget(tour: GuideTourView, firstPassword: boolean) {
  const saving = firstPassword && tour.target === "item.editor.save";
  const generating =
    firstPassword && tour.target === "editor.generate-password";
  const recovery = useSyncExternalStore(
    saving || generating ? subscribeRecovery : noSubscription,
    saving
      ? recoverySnapshot
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

/** A focused form step may hold Next until its highlighted value is valid. */
function useNextBlocked(target: GuideTourView["target"]): boolean {
  const blocked = () =>
    target !== null &&
    resolveGuideTargetElement(target)?.dataset.guideNextBlocked === "true";
  const subscribe = (listener: () => void) => {
    let observer: MutationObserver | null = null;
    const refresh = () => {
      observer?.disconnect();
      const element =
        target === null ? null : resolveGuideTargetElement(target);
      if (element) {
        observer = new MutationObserver(listener);
        observer.observe(element, {
          attributes: true,
          attributeFilter: ["data-guide-next-blocked"],
        });
      }
      listener();
    };
    const unsubscribe = subscribeToGuideTargets(refresh);
    refresh();
    return () => {
      observer?.disconnect();
      unsubscribe();
    };
  };
  return useSyncExternalStore(
    target === null ? noSubscription : subscribe,
    blocked,
    notBlocked,
  );
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
  if (rect === null || viewport.width >= 230 || viewport.height >= 110)
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
  const narrow = viewport.width < 230;
  return {
    narrow,
    short: narrow && viewport.height < 110 && viewport.scale > 1,
    constrained:
      narrow ||
      (maxHeight !== undefined && maxHeight < CONSTRAINED_CARD_HEIGHT),
  };
}

export function guidedTour(
  tour: GuideTourView,
  blocked: boolean,
): GuideTourView {
  return blocked ? { ...tour, action: true } : tour;
}

export function coachLayoutFlags(
  layout: ReturnType<typeof useCoachLayout>,
  tour: GuideTourView,
  requiredAction: boolean,
  canBack: boolean,
) {
  const awaitingAction =
    layout.constrained &&
    requiredAction &&
    tour.action &&
    !layout.missing &&
    !canBack;
  const shortScroll =
    layout.short &&
    (canBack ||
      tour.kind === "close" ||
      (!awaitingAction && layout.viewport.width < 200));
  const compactRow =
    !shortScroll &&
    layout.constrained &&
    (!layout.narrow || (layout.short && !canBack)) &&
    !awaitingAction &&
    layout.maxHeight !== undefined &&
    layout.maxHeight < 90;
  return { awaitingAction, shortScroll, compactRow };
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
  const relativeBox =
    box === null
      ? null
      : {
          ...box,
          left: box.left - viewport.offsetLeft,
          top: box.top - viewport.offsetTop,
        };
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
  const placement =
    relativePlacement && relativePlacement.kind !== "dock"
      ? {
          ...relativePlacement,
          left: relativePlacement.left + viewport.offsetLeft,
          top: relativePlacement.top + viewport.offsetTop,
        }
      : relativePlacement;
  const relativeHole =
    relativeBox !== null && size !== null && placement?.kind === "dock"
      ? clearOfDock(relativeBox, viewport, size, placement.edge, insets)
      : relativeBox;
  const hole =
    relativeHole === null
      ? null
      : {
          ...relativeHole,
          left: relativeHole.left + viewport.offsetLeft,
          top: relativeHole.top + viewport.offsetTop,
        };
  const maxHeight = phone
    ? phoneCardHeightLimit(viewport, placementBox, insets)
    : undefined;
  return {
    stepKey,
    target,
    recovery,
    nextBlocked: useNextBlocked(target),
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
