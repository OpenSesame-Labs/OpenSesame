/**
 * The pieces of the tutorial card: the dim with its aperture, the meter, the
 * head and the foot. Each draws data the runtime already published and holds
 * no state of its own.
 */

import { FIRST_VAULT_PIN_STEPS } from "@opensesame/app-core/tutorial/registry/first-vault-guide.js";
import type { GuideTourView } from "@opensesame/guide-runtime";
import type { CSSProperties, ReactElement } from "react";
import { IconKey } from "../../components/IconKey.js";
import {
  IconAlert,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconRefresh,
  IconSupport,
  IconX,
} from "../../components/Icons.js";
import type { SupportController } from "../session.js";
import { type Box, type CoachPlacement, isTightViewport } from "./placement.js";

/** How far the aperture stands off the control it lights. */
export const APERTURE_PAD = 6;

export const CLOSING_TEXT = "Tutorial complete.";

/** Describe a recovery control when the original action cannot yet succeed. */
export function coachMessage(
  tour: GuideTourView,
  requiredAction: boolean,
  ready: boolean,
  recovery: "edit" | "options" | "pepper" | "",
): string | null {
  if (recovery === "edit")
    return "There is no generated password to copy. Select Edit.";
  if (recovery === "options")
    return "Open Password options to change the pepper position.";
  if (recovery === "pepper")
    return "Set the pepper position to end or turn off Include pepper.";
  if (requiredAction && ready && !tour.action) {
    if (tour.target === "editor.password-options")
      return "Password options are open. Select Next.";
    if (tour.target === "unlock.seal-actions")
      return "PIN is selected. Select Next.";
  }
  return tour.message;
}

type TourProgress = { offset: number; count: number };

/**
 * First-vault meter lengths, pinned to the authored walks in
 * `@opensesame/app-core/tutorial/registry/first-vault-guide.ts`: the door
 * walks two setup steps plus a two-step road to the seal decision, the PIN
 * road then walks `FIRST_VAULT_PIN_STEPS`' seal fields where the passkey road
 * seals in one ceremony, and the shell continuation is the eight-step password
 * walk. CoachHud.test.tsx re-derives these from the authored guides, so an
 * edit that changes a walk's length fails the meter test instead of drifting
 * the counter silently.
 */
const FIRST_VAULT_PASSKEY_GATE_STEPS = 4;
const FIRST_VAULT_PIN_SEAL_STEPS = FIRST_VAULT_PIN_STEPS.length;
const FIRST_VAULT_PIN_GATE_STEPS =
  FIRST_VAULT_PASSKEY_GATE_STEPS + FIRST_VAULT_PIN_SEAL_STEPS;
export const FIRST_VAULT_SHELL_STEPS = 8;

/** Join the adaptive gate phase to its first-vault shell continuation. */
export function firstVaultTourProgress(
  target: string | null,
  count: number,
  gateSteps: number,
): TourProgress {
  const gateTarget =
    target?.startsWith("unlock.") || target === "setup.default";
  const pinTarget = [
    "unlock.seal-pin-entry",
    "unlock.seal-pin-confirm",
    "unlock.seal-ack",
    "unlock.seal",
  ].includes(target ?? "");
  // The shell continuation waits for the saved item and a successful copy.
  if (count === FIRST_VAULT_SHELL_STEPS && !gateTarget)
    return { offset: gateSteps, count: gateSteps + count };
  // The gate phase and the sign-in continuation show the whole projected
  // walk: the passkey road's total until the PIN fields open, the PIN road's
  // from then on. The sign-in continuation resumes after the door's two
  // setup steps: six steps on the PIN road, two where the passkey seals in
  // one ceremony.
  const signIn = count === 6 || count === 2;
  const roadSteps = pinTarget
    ? FIRST_VAULT_PIN_GATE_STEPS
    : FIRST_VAULT_PASSKEY_GATE_STEPS;
  return { offset: signIn ? 2 : 0, count: roadSteps + FIRST_VAULT_SHELL_STEPS };
}

export function padded(box: Box): Box {
  return {
    left: box.left - APERTURE_PAD,
    top: box.top - APERTURE_PAD,
    width: box.width + APERTURE_PAD * 2,
    height: box.height + APERTURE_PAD * 2,
  };
}

/** The four panels of dim around an aperture; pointer events pass through. */
export function Dim({
  hole,
  viewport,
  gliding,
}: {
  hole: Box | null;
  viewport: { width: number; height: number };
  gliding: boolean;
}): ReactElement {
  const box = hole ?? {
    left: viewport.width / 2,
    top: viewport.height / 2,
    width: 0,
    height: 0,
  };
  const top = Math.max(0, box.top);
  const bottom = Math.max(top, box.top + box.height);
  const left = Math.max(0, box.left);
  const right = Math.max(left, box.left + box.width);
  const panel = (style: CSSProperties): ReactElement => (
    <div
      className={`coach__dim${gliding ? " is-gliding" : ""}`}
      style={style}
      aria-hidden="true"
    />
  );
  return (
    <>
      {panel({ top: 0, left: 0, width: "100%", height: top })}
      {panel({ top: bottom, left: 0, width: "100%", bottom: 0 })}
      {panel({ top, left: 0, width: left, height: bottom - top })}
      {panel({ top, left: right, right: 0, height: bottom - top })}
    </>
  );
}

export function Ring({
  hole,
  gliding,
  action,
}: {
  hole: Box;
  gliding: boolean;
  action: boolean;
}): ReactElement {
  return (
    <div
      className={`coach__ring${gliding ? " is-gliding" : ""}${action ? " is-action" : ""}`}
      style={{
        left: hole.left,
        top: hole.top,
        width: hole.width,
        height: hole.height,
      }}
      aria-hidden="true"
    />
  );
}

export function Meter({ tour }: { tour: GuideTourView }): ReactElement {
  const positions = Array.from(
    { length: Math.max(tour.count, 1) },
    (_, at) => at + 1,
  );
  return (
    <div className="coach__meter" aria-hidden="true">
      {positions.map((position) => {
        const state =
          tour.kind === "close" || position < tour.step
            ? "done"
            : position === tour.step
              ? "now"
              : "ahead";
        return (
          <span key={position} className={`coach__seg coach__seg--${state}`} />
        );
      })}
    </div>
  );
}

/** "Step 2 of 5", or "Complete" on the closing card. */
export function counterOf(tour: GuideTourView): string {
  if (tour.kind === "close") return "Complete";
  return tour.count > 0 ? `Step ${tour.step} of ${tour.count}` : "";
}

/** The coach exit key, found by attribute so focus never depends on copy. */
export const COACH_EXIT_SELECTOR = "[data-coach-exit]";

export function Head({
  titleId,
  title,
  counter,
  closing,
  support,
}: {
  titleId: string;
  title: string;
  counter: string;
  closing: boolean;
  support: SupportController;
}): ReactElement {
  return (
    <header className="coach__head">
      <span className="coach__mark" aria-hidden="true">
        {closing ? <IconCheck size={16} /> : <IconSupport size={16} />}
      </span>
      <h2 className="coach__title" id={titleId}>
        <span className="visually-hidden">Tutorial: </span>
        {title}
      </h2>
      <span className="coach__count">{counter}</span>
      <IconKey
        small
        label="Exit tutorial"
        data-coach-exit=""
        onClick={() => support.stopGuide()}
      >
        <IconX size={15} />
      </IconKey>
    </header>
  );
}

function Cue({
  missing,
  action,
}: {
  missing: boolean;
  action: boolean;
}): ReactElement | null {
  if (missing) {
    return (
      <>
        <IconAlert size={14} />
        not on screen
      </>
    );
  }
  if (!action) return null;
  return (
    <>
      <span className="coach__pulse" aria-hidden="true" />
      Complete this step
    </>
  );
}

export function Foot({
  tour,
  missing,
  support,
  primary,
  firstVault,
  canBack,
  requiredAction,
  ready,
}: {
  tour: GuideTourView;
  missing: boolean;
  support: SupportController;
  primary: React.Ref<HTMLButtonElement>;
  firstVault: boolean;
  canBack: boolean;
  requiredAction: boolean;
  ready: boolean;
}): ReactElement {
  const closing = tour.kind === "close";
  return (
    <footer className="coach__foot">
      <span className="coach__cue">
        <Cue missing={missing} action={tour.action} />
      </span>
      <div className="coach__keys">
        {closing ? (
          <button
            type="button"
            className="coach__btn"
            aria-label={firstVault ? "Replay password steps" : "Replay"}
            disabled={!ready}
            onClick={() => support.replayGuide()}
          >
            <IconRefresh size={15} />
            <span>{firstVault ? "Replay steps" : "Replay"}</span>
          </button>
        ) : (
          <button
            type="button"
            className="coach__btn coach__btn--back"
            aria-label="Back"
            disabled={!ready || !canBack}
            onClick={() => support.backStep()}
          >
            <IconChevronLeft size={15} />
            <span>Back</span>
          </button>
        )}
        <button
          ref={primary}
          type="button"
          className="coach__btn coach__btn--go"
          aria-disabled={
            !ready || (requiredAction && tour.action) ? true : undefined
          }
          onClick={() => {
            if (ready && (!requiredAction || !tour.action)) support.nextStep();
          }}
        >
          {closing ? (
            <>
              Done
              <IconCheck size={15} />
            </>
          ) : (
            <>
              Next
              <IconChevronRight size={15} />
            </>
          )}
        </button>
      </div>
    </footer>
  );
}

export function viewportDockStyle(
  placement: CoachPlacement | null,
  viewport: {
    width: number;
    height: number;
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
  const edge = isTightViewport(viewport) ? "0px" : "0.5rem";
  if (placement.edge === "top") {
    return {
      ...horizontal,
      top: `calc(${edge} + env(safe-area-inset-top, 0px) + ${viewport.offsetTop}px)`,
    };
  }
  return {
    ...horizontal,
    bottom: `calc(${edge} + env(safe-area-inset-bottom, 0px) + ${viewport.bottomOffset}px)`,
  };
}
