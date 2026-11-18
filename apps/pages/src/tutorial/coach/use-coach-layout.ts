import { resolveGuideTargetElement } from "@opensesame/app-core/tutorial/registry/targets.js";
import type { GuideTourView } from "@opensesame/guide-runtime";
import { type RefObject, useCallback } from "react";
import { padded } from "./CoachParts.js";
import { clearOfDock, phoneCardHeightLimit, placeCoach } from "./placement.js";
import { useGlide } from "./use-coach-behavior.js";
import {
  useLiveRect,
  useMeasured,
  usePhoneLayout,
  useSafeInsets,
  useViewport,
} from "./use-geometry.js";

/**
 * Where everything goes for one step: the aperture around the lit control,
 * the card beside it, and whether the control is there at all. Pure
 * arithmetic over what the page reports each frame.
 */
export function useCoachLayout(
  runId: number,
  tour: GuideTourView,
  card: RefObject<HTMLElement | null>,
) {
  const target = tour.target;
  const stepKey = `${runId}:${tour.kind}:${tour.step}`;
  const rect = useLiveRect(
    useCallback(
      () =>
        target !== null && !tour.degraded
          ? resolveGuideTargetElement(target)
          : null,
      [target, tour.degraded],
    ),
    stepKey,
  );
  const viewport = useViewport();
  const phone = usePhoneLayout();
  const insets = useSafeInsets();
  const size = useMeasured(card, `${stepKey}:${tour.message}:${phone}`);
  const box = rect === null ? null : padded(rect);
  const relativeBox =
    box === null ? null : { ...box, top: box.top - viewport.offsetTop };
  const relativePlacement =
    size === null
      ? null
      : placeCoach({
          viewport,
          card: size,
          target: relativeBox,
          prefer: tour.side,
          phone,
          insets,
        });
  const placement =
    relativePlacement && relativePlacement.kind !== "dock"
      ? {
          ...relativePlacement,
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
      : { ...relativeHole, top: relativeHole.top + viewport.offsetTop };
  return {
    stepKey,
    viewport,
    hole,
    placement,
    maxHeight: phone
      ? phoneCardHeightLimit(viewport, relativeBox, insets)
      : undefined,
    gliding: useGlide(stepKey),
    // A control that was on screen and is gone — the person navigated away —
    // is the same situation as one that never appeared.
    missing: target !== null && (tour.degraded || rect === null),
  };
}
