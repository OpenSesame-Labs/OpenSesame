/**
 * The toasts: the transient echo of a notice (ADR 0162; the policy is
 * app-core `lib/notice-toast.ts`). A toast carries the tray notice's own words,
 * sits as a fixed block above the statusline (the shell or a shellless
 * screen), and goes after a few seconds unless the person is reading it. It
 * takes no layout space, so an arrival cannot resize a pane. The tray keeps
 * the notice.
 *
 * An offer or a recommendation (ADR 0221) has a worded key and no clock.
 * In the shell it is presented in a compact in-flow row until reviewed,
 * answered, or taken back (ADR 0225).
 *
 * It is one polite live region, drawn whether or not anything is showing, so
 * an arrival is announced where it is added. A failure is a tone on a notice
 * card, not a box and not an alert (DESIGN.md § Status is a symbol).
 */

import {
  type ToastMessage,
  arrivalSurface,
  desktopRinging,
  subscribeToastHides,
  subscribeToasts,
  toastOf,
} from "@opensesame/app-core/lib/notice-toast.js";
import {
  listNotices,
  subscribeNoticeArrivals,
  subscribeNotices,
} from "@opensesame/app-core/lib/notices.js";
import { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";
import { landFocus } from "../lib/focus.js";
import { ringDesktopNotice, tabAway } from "../lib/notice-desktop.js";
import { IconAlert, IconInfo } from "./Icons.js";
import { InlineRecommendations } from "./InlineRecommendations.js";
import { dismissContext } from "./notice-dismiss-context.js";
import { useToastPlacement, useToastQueue } from "./use-toast-queue.js";
import { useToastReading } from "./use-toast-reading.js";

/** How long a toast stays when the person is not reading it. */
export const TOAST_MS = 6000;

export { TOAST_LIMIT, withinLimit } from "./use-toast-queue.js";

export function ToastStack({
  inlineSeat,
  active = true,
  inFlowGateNotices = false,
}: {
  inlineSeat?: HTMLElement | null;
  active?: boolean;
  inFlowGateNotices?: boolean;
} = {}) {
  const navigate = useNavigate();
  const { className, editing } = useToastPlacement();
  const { shown, markReading, add, dismiss, handBack } = useToastQueue(
    active,
    inlineSeat !== undefined,
    editing,
  );

  // A card's key goes with its card. Where the press was made from the
  // keyboard, focus goes back to wherever it was before it entered the
  // stack, instead of falling to the document (DESIGN.md § keyboard).
  const region = useRef<HTMLOutputElement>(null);
  const before = useRef<Element | null>(null);
  useEffect(() => {
    const note = (event: FocusEvent) => {
      const { target } = event;
      if (!(target instanceof Element)) return;
      if (!region.current?.contains(target)) before.current = target;
    };
    document.addEventListener("focusin", note);
    return () => document.removeEventListener("focusin", note);
  }, []);
  const answer = useCallback(
    (id: string) => {
      handBack.current =
        region.current?.contains(document.activeElement) === true;
      dismiss(id);
    },
    [dismiss, handBack],
  );
  // After the card is gone: only if nothing else took focus meanwhile — a
  // tour's card, or the page a key navigated to, keeps it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the stack changes
  useEffect(() => {
    if (!handBack.current) return;
    handBack.current = false;
    const lost =
      document.activeElement === null ||
      document.activeElement === document.body;
    if (lost) landFocus(before.current);
  }, [shown]);

  useToastSubscriptions(add, dismiss, navigate, inFlowGateNotices);
  return (
    <ToastSurfaces
      shown={shown}
      inlineSeat={inlineSeat}
      active={active}
      editing={editing}
      className={className}
      region={region}
      answer={answer}
      dismiss={dismiss}
      onOpen={navigate}
      onReading={markReading}
    />
  );
}

function useToastSubscriptions(
  add: (toast: ToastMessage) => void,
  dismiss: (id: string) => void,
  navigate: (to: string) => void,
  inFlowGateNotices: boolean,
) {
  // An echo waits only while its tray notice is still present.
  const echoes = useRef(new Set<string>());
  useEffect(() => subscribeToasts(add), [add]);
  useEffect(() => subscribeToastHides(dismiss), [dismiss]);
  useEffect(
    () =>
      subscribeNoticeArrivals((notice) => {
        const surface = arrivalSurface({
          away: tabAway(),
          desktop: desktopRinging(),
        });
        if (surface === "toast") {
          // The gate already draws these complete notices in its own flow.
          if (
            inFlowGateNotices &&
            ((notice.kind === "status" && notice.tone === "err") ||
              notice.id.startsWith("identity.claim."))
          )
            return;
          echoes.current.add(notice.id);
          add(toastOf(notice));
        } else if (surface === "desktop") ringDesktopNotice(notice, navigate);
      }),
    [add, navigate, inFlowGateNotices],
  );
  useEffect(
    () =>
      subscribeNotices(() => {
        const held = new Set(listNotices().map((notice) => notice.id));
        for (const id of [...echoes.current]) {
          if (held.has(id)) continue;
          echoes.current.delete(id);
          dismiss(id);
        }
      }),
    [dismiss],
  );
}

function ToastSurfaces({
  shown,
  inlineSeat,
  active,
  editing,
  className,
  region,
  answer,
  dismiss,
  onOpen,
  onReading,
}: {
  shown: readonly ToastMessage[];
  inlineSeat: HTMLElement | null | undefined;
  active: boolean;
  editing: boolean;
  className: string;
  region: React.RefObject<HTMLOutputElement | null>;
  answer: (id: string) => void;
  dismiss: (id: string) => void;
  onOpen: (to: string) => void;
  onReading: (id: string, channel: "pointer" | "focus", value: boolean) => void;
}) {
  const inFlow = inlineSeat !== undefined;
  return (
    <>
      <output
        className={className}
        aria-label="Temporary notifications"
        aria-live="polite"
        ref={region}
      >
        {active
          ? shown
              .filter((toast) => !(inFlow || editing) || !toast.sticky)
              .map((toast) => (
                <Toast
                  key={toast.id}
                  toast={toast}
                  dismissContext={dismissContext(toast, shown)}
                  onDone={answer}
                  onOpen={onOpen}
                  onReading={onReading}
                />
              ))
          : null}
      </output>
      {inlineSeat
        ? createPortal(
            <InlineRecommendations
              items={shown.filter((toast) => toast.sticky)}
              active={active && !editing}
              onDone={dismiss}
              onOpen={onOpen}
            />,
            inlineSeat,
          )
        : null}
    </>
  );
}

function Toast({
  toast,
  dismissContext,
  onDone,
  onOpen,
  onReading,
}: {
  toast: ToastMessage;
  dismissContext: string;
  onDone: (id: string) => void;
  onOpen: (to: string) => void;
  onReading: (id: string, channel: "pointer" | "focus", value: boolean) => void;
}) {
  const reading = useToastReading(toast, onDone, onReading, TOAST_MS);
  const { sticky } = toast;
  const { tone } = toast;
  const kind = sticky ? "offer" : "notification";
  return (
    <article
      className={`notice-card notice-card--${tone} toast${
        sticky ? " toast--offer" : ""
      }`}
      onPointerEnter={reading.enter}
      onPointerLeave={reading.leave}
      onFocus={reading.focus}
      onBlur={reading.blur}
    >
      <h3>
        {tone === "info" ? <IconInfo size={16} /> : <IconAlert size={16} />}
        <span>
          <span className="toast__kind">
            {sticky ? "Offer" : "Notification"}:{" "}
          </span>
          {toast.title}
        </span>
      </h3>
      <p>{toast.body}</p>
      <div className="actions">
        {toast.choice ? (
          <button
            type="button"
            className="btn btn--primary btn--sm choice toast__choice"
            onClick={() => {
              onDone(toast.id);
              toast.choice?.run();
            }}
          >
            {toast.choice.label}
          </button>
        ) : null}
        {toast.alt ? (
          <button
            type="button"
            className="btn btn--sm choice"
            onClick={() => {
              onDone(toast.id);
              toast.alt?.run();
            }}
          >
            {toast.alt.label}
          </button>
        ) : null}
        {toast.open ? (
          <button
            type="button"
            className="btn btn--sm choice"
            onClick={() => {
              onDone(toast.id);
              if (toast.open) onOpen(toast.open.to);
            }}
          >
            {toast.open.label}
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn--sm btn--ghost notice-dismiss"
          aria-label={`Dismiss ${kind}: ${dismissContext}`}
          onClick={() => {
            onDone(toast.id);
            toast.onDismiss?.();
          }}
        >
          Dismiss
        </button>
      </div>
    </article>
  );
}
