/**
 * The toasts: the transient echo of a notice (ADR 0162; the policy is
 * app-core `lib/notice-toast.ts`). A toast carries the tray notice's own words,
 * sits as a fixed block above the statusline (the shell or a shellless
 * screen), and goes after a few seconds unless the person is reading it. It
 * takes no layout space, so an arrival cannot resize a pane. The tray keeps
 * the notice.
 *
 * An offer or a recommendation (ADR 0221) is the same card with a worded key
 * and no clock: it stays until it is answered or taken back.
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
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { landFocus } from "../lib/focus.js";
import { ringDesktopNotice, tabAway } from "../lib/notice-desktop.js";
import { useNarrow } from "../lib/use-narrow.js";
import { IconKey } from "./IconKey.js";
import { IconAlert, IconArrowRight, IconInfo, IconX } from "./Icons.js";
import { useToastQueue, withinLimit } from "./use-toast-queue.js";
import { useToastSuppression } from "./use-toast-suppression.js";

/** How long a toast stays when the person is not reading it. */
export const TOAST_MS = 6000;

/** How many toasts are on screen at once; the rest are only in the tray. */
export { TOAST_LIMIT, withinLimit } from "./use-toast-queue.js";

export function ToastStack() {
  const navigate = useNavigate();
  const { deferOffers, shouldDefer } = useToastSuppression();
  const narrow = useNarrow();
  const { shown, add, dismiss } = useToastQueue(
    deferOffers,
    narrow,
    shouldDefer,
  );

  // A card's key goes with its card. Where the press was made from the
  // keyboard, focus goes back to wherever it was before it entered the
  // stack, instead of falling to the document (DESIGN.md § keyboard).
  const region = useRef<HTMLOutputElement>(null);
  const before = useRef<Element | null>(null);
  const handBack = useRef(false);
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
    [dismiss],
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

  // The cards that echo a tray notice, by the notice's id. An echo that
  // waits to be answered must go when its notice does — answered or
  // dismissed from the tray — or it would stand there offering a key for
  // something already settled.
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
          echoes.current.add(notice.id);
          add(toastOf(notice));
        } else if (surface === "desktop") ringDesktopNotice(notice, navigate);
      }),
    [add, navigate],
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

  return (
    <output className="toasts" aria-live="polite" ref={region}>
      <ToastCards
        shown={shown}
        deferOffers={deferOffers}
        narrow={narrow}
        onDone={answer}
        onOpen={navigate}
      />
    </output>
  );
}

function ToastCards({
  shown,
  deferOffers,
  narrow,
  onDone,
  onOpen,
}: {
  shown: ToastMessage[];
  deferOffers: boolean;
  narrow: boolean;
  onDone: (id: string) => void;
  onOpen: (to: string) => void;
}) {
  const visible = shown
    .filter(
      (toast) => !toast.sticky || (!deferOffers && !(narrow && toast.inTray)),
    )
    .reduce<ToastMessage[]>((held, toast) => withinLimit(held, toast), []);
  return visible.map((toast) => (
    <Toast key={toast.id} toast={toast} onDone={onDone} onOpen={onOpen} />
  ));
}

function Toast({
  toast,
  onDone,
  onOpen,
}: {
  toast: ToastMessage;
  onDone: (id: string) => void;
  onOpen: (to: string) => void;
}) {
  // Reading it (a pointer or focus on the card) holds it; leaving resumes the
  // time it had left, so a toast is never cut short by a glance away.
  const [reading, setReading] = useState(false);
  const left = useRef(TOAST_MS);
  const since = useRef(0);
  const { sticky } = toast;
  useEffect(() => {
    // An offer waits to be answered; only an echo leaves on the clock.
    if (reading || sticky) return;
    since.current = Date.now();
    const timer = setTimeout(() => onDone(toast.id), left.current);
    return () => {
      clearTimeout(timer);
      left.current -= Date.now() - since.current;
    };
  }, [reading, sticky, onDone, toast.id]);

  const { tone } = toast;
  return (
    <article
      className={`notice-card notice-card--${tone} toast${
        sticky ? " toast--offer" : ""
      }`}
      onPointerEnter={() => setReading(true)}
      onPointerLeave={() => setReading(false)}
      onFocus={() => setReading(true)}
      onBlur={() => setReading(false)}
    >
      <h3>
        {tone === "info" ? <IconInfo size={16} /> : <IconAlert size={16} />}
        {toast.title}
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
        {toast.open ? (
          <IconKey
            label={toast.open.label}
            small
            onClick={() => {
              onDone(toast.id);
              if (toast.open) onOpen(toast.open.to);
            }}
          >
            <IconArrowRight size={16} />
          </IconKey>
        ) : null}
        <IconKey
          label="Dismiss"
          small
          onClick={() => {
            onDone(toast.id);
            toast.onDismiss?.();
          }}
        >
          <IconX size={16} />
        </IconKey>
      </div>
    </article>
  );
}
