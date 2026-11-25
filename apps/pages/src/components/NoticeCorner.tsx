import {
  type Notice,
  listNotices,
  subscribeNotices,
} from "@opensesame/app-core/lib/notices.js";
import { TUTORIAL_PAUSE_NOTICE } from "@opensesame/app-core/lib/tutorial-queue.js";
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { keyboardIsIdle, landFocus } from "../lib/focus.js";
import { NotificationsBar, StatusNoticeCard } from "./NotificationsBar.js";

/** Keep a keyboard reader's card mounted when a newer notice arrives. */
function visibleNotices(
  notices: readonly Notice[],
  held: Notice | null,
): Notice[] {
  const error = [...notices]
    .reverse()
    .find((notice) => notice.kind === "status" && notice.tone === "err");
  const claim = [...notices]
    .reverse()
    .find((notice) => notice.id.startsWith("identity.claim."));
  const tutorialPause = notices.find(
    (notice) => notice.id === TUTORIAL_PAUSE_NOTICE,
  );
  const selected = new Set([
    held && notices.includes(held) ? held : null,
    error,
    claim,
    tutorialPause,
  ]);
  // Keep tab order stable when focus moves between cards: the held card's
  // position must not jump ahead of other visible arrivals.
  return notices.filter((notice) => selected.has(notice));
}

function dismissName(notice: Notice, notices: readonly Notice[]): string {
  const matches = notices.filter(
    (item) => item.title === notice.title && item.body === notice.body,
  );
  const ordinal =
    matches.length > 1
      ? ` (${matches.indexOf(notice) + 1} of ${matches.length})`
      : "";
  return `${notice.title}. ${notice.body}${ordinal}`;
}

function useNoticeFocus(
  ids: string,
  corner: React.RefObject<HTMLDivElement | null>,
) {
  const before = useRef<Element | null>(document.activeElement);
  const inside = useRef<Element | null>(null);
  useEffect(() => {
    const remember = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (corner.current?.contains(target)) inside.current = target;
      else {
        before.current = target;
        inside.current = null;
      }
    };
    document.addEventListener("focusin", remember);
    return () => document.removeEventListener("focusin", remember);
  }, [corner]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: ids tracks removed cards
  useLayoutEffect(() => {
    if (!inside.current || inside.current.isConnected || !keyboardIsIdle())
      return;
    if (!landFocus(corner.current?.querySelector(".cx__btn")))
      landFocus(before.current);
  }, [ids]);
}

/** A shellless screen announces its notices in flow, beside its bell. */
export function NoticeCorner({
  heldNotice,
  onHeldChange,
}: {
  heldNotice?: Notice | null;
  onHeldChange?: (notice: Notice | null) => void;
} = {}) {
  const notices = useSyncExternalStore(subscribeNotices, listNotices);
  const [localHeld, setLocalHeld] = useState<Notice | null>(null);
  const held = onHeldChange ? (heldNotice ?? null) : localHeld;
  const hold = onHeldChange ?? setLocalHeld;
  const corner = useRef<HTMLDivElement>(null);
  const keys = useRef(new WeakMap<Notice, number>());
  const nextKey = useRef(0);
  const keyOf = (notice: Notice) => {
    if (!keys.current.has(notice)) keys.current.set(notice, nextKey.current++);
    return keys.current.get(notice) ?? 0;
  };
  const visible = visibleNotices(notices, held);
  const latestError = [...notices]
    .reverse()
    .find((notice) => visible.includes(notice) && notice.tone === "err");
  const latestUpdate = [...notices]
    .reverse()
    .find((notice) => visible.includes(notice) && notice.tone !== "err");
  useNoticeFocus(visible.map(keyOf).join("\0"), corner);
  useEffect(() => {
    if (held && !notices.includes(held)) hold(null);
  }, [held, notices, hold]);
  const card = (notice: Notice) => (
    <div
      className="notice-corner__card"
      data-notice-id={notice.id}
      key={keyOf(notice)}
      onFocusCapture={() => hold(notice)}
      onBlurCapture={(event) => {
        const next = event.relatedTarget;
        if (event.currentTarget.contains(next)) return;
        // Keep the old card until focus lands on the next card. Removing it
        // during the browser's Tab transition can skip the remaining cards.
        if (
          next instanceof Element &&
          corner.current?.contains(next) &&
          next.closest(".notice-corner__card")
        )
          return;
        hold(null);
      }}
    >
      <StatusNoticeCard
        notice={notice}
        onOpen={() => undefined}
        inFlow
        dismissContext={dismissName(notice, notices)}
      />
    </div>
  );
  return (
    <div
      className="notice-corner"
      data-active={notices.length ? "" : undefined}
      ref={corner}
    >
      <output
        className="visually-hidden"
        role="alert"
        aria-label="Urgent notifications"
      >
        {latestError ? (
          <Fragment key={keyOf(latestError)}>
            {`Notification: ${latestError.title}. ${latestError.body}`}
          </Fragment>
        ) : null}
      </output>
      <output
        className="visually-hidden"
        aria-label="Notifications"
        aria-live="polite"
      >
        {latestUpdate ? (
          <Fragment key={keyOf(latestUpdate)}>
            {`Notification: ${latestUpdate.title}. ${latestUpdate.body}`}
          </Fragment>
        ) : null}
      </output>
      <div className="notice-corner__cards">{visible.map(card)}</div>
      {notices.length ? <NotificationsBar /> : null}
    </div>
  );
}
