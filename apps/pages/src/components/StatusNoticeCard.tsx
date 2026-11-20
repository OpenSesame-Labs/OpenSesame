import {
  type Notice,
  dismissNotice,
} from "@opensesame/app-core/lib/notices.js";
import { type RefObject, useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { firstControl, landFocus } from "../lib/focus.js";
import { CeremonyLink } from "./CeremonyLauncher.js";
import { IconKey } from "./IconKey.js";
import {
  IconAlert,
  IconArrowRight,
  IconInfo,
  IconPower,
  IconRefresh,
  IconSettings,
  IconUpload,
  IconX,
} from "./Icons.js";

/** The face of a notice's act: what the key does, not one mark for all. */
function ActIcon({ icon }: { icon: NonNullable<Notice["act"]>["icon"] }) {
  if (icon === "export") return <IconUpload size={16} />;
  if (icon === "settings") return <IconSettings size={16} />;
  return <IconPower size={16} />;
}

/**
 * The notice whose act was pressed from the keyboard and that has not been
 * answered yet. An act that works in place — a recommendation turning a
 * feature on — replaces its own card with the outcome, and the key it was
 * pressed on goes with it; the card it leaves behind takes focus back.
 */
let handBack: string | null = null;

function NoticeHeading({
  tone,
  title,
  inFlow,
}: {
  tone: Notice["tone"];
  title: string;
  inFlow: boolean;
}) {
  return (
    <h3>
      {tone === "info" ? <IconInfo size={16} /> : <IconAlert size={16} />}
      <span>
        {inFlow ? "Notification: " : null}
        {title}
      </span>
    </h3>
  );
}

function NoticeRetry({ notice, inFlow }: { notice: Notice; inFlow: boolean }) {
  if (!notice.retry) return null;
  return (
    <IconKey
      label={notice.retryLabel ?? "Try again"}
      small
      onClick={() => notice.retry?.()}
    >
      <IconRefresh size={16} />
      {inFlow ? (
        <span className="notice-action-label">
          {notice.retryLabel ?? "Try again"}
        </span>
      ) : null}
    </IconKey>
  );
}

function wordedPair(notice: Notice): boolean {
  return notice.act?.worded === true && notice.alt?.worded === true;
}

function runStoredAct(
  act: NonNullable<Notice["act"]>,
  noticeId: string,
  fromKeyboard: boolean,
  onOpen: () => void,
): void {
  if (act.opens) onOpen();
  else if (fromKeyboard) handBack = noticeId;
  act.run();
}

function WordedActs({
  notice,
  onOpen,
  actionsRef,
  wordedTray,
}: {
  notice: Notice;
  onOpen: () => void;
  actionsRef: RefObject<HTMLDivElement | null>;
  wordedTray: boolean;
}) {
  const act = notice.act;
  const alt = notice.alt;
  if (!act || !alt) return null;
  const runWorded = (opens: boolean | undefined, run: () => void) => {
    const fromKeyboard =
      actionsRef.current?.contains(document.activeElement) ?? false;
    // An opening choice moves focus onto the page. A tray choice lands on
    // Close. Arming hand-back on either path pulls focus back onto this
    // card once its act disappears.
    if (fromKeyboard && !opens && !wordedTray) handBack = notice.id;
    let trayClose: HTMLButtonElement | null = null;
    if (!opens && wordedTray && fromKeyboard) {
      const dialog = actionsRef.current?.closest('[role="dialog"]');
      trayClose =
        dialog?.querySelector<HTMLButtonElement>(
          'button[aria-label="Close"]',
        ) ?? null;
    }
    if (opens) onOpen();
    run();
    if (opens) return;
    if (wordedTray) {
      if (trayClose) queueMicrotask(() => landFocus(trayClose));
      return;
    }
    // A keyboard press armed hand-back: the card this act leaves behind takes
    // focus back, so focus must not move onto the page. Only a pointer press
    // has no card to return to and moves on like an opening act.
    if (!fromKeyboard) onOpen();
  };
  return (
    <>
      <button
        type="button"
        className="btn btn--primary btn--sm choice"
        onClick={() => runWorded(act.opens, act.run)}
      >
        {act.label}
      </button>
      <button
        type="button"
        className="btn btn--sm choice"
        onClick={() => runWorded(alt.opens, alt.run)}
      >
        {alt.label}
      </button>
    </>
  );
}

function NoticeDismiss({
  notice,
  inFlow,
  title,
}: {
  notice: Notice;
  inFlow: boolean;
  title: string;
}) {
  if (inFlow)
    return (
      <button
        type="button"
        className="btn btn--sm btn--ghost notice-dismiss"
        aria-label={`Dismiss notification: ${title}`}
        onClick={() => dismissNotice(notice.id)}
      >
        Dismiss
      </button>
    );
  return (
    <IconKey label="Dismiss" small onClick={() => dismissNotice(notice.id)}>
      <IconX size={16} />
    </IconKey>
  );
}

export function StatusNoticeCard({
  notice,
  onOpen,
  inFlow = false,
  wordedTray = false,
  dismissContext,
}: {
  notice: Notice;
  onOpen: () => void;
  inFlow?: boolean;
  wordedTray?: boolean;
  dismissContext?: string;
}) {
  const tone = notice.tone ?? "info";
  const dismissTitle = dismissContext ?? notice.title;
  const navigate = useNavigate();
  const actions = useRef<HTMLDivElement>(null);
  const act = notice.act;
  const pressAct = () => {
    if (!act) return;
    runStoredAct(
      act,
      notice.id,
      actions.current?.contains(document.activeElement) ?? false,
      onOpen,
    );
  };
  // Once the act's key is gone, and only if nothing else took focus
  // meanwhile, focus lands on the first key the card still has.
  useEffect(() => {
    if (handBack !== notice.id || notice.act) return;
    handBack = null;
    const lost =
      document.activeElement === null ||
      document.activeElement === document.body;
    if (lost) landFocus(firstControl(actions.current));
  }, [notice]);
  return (
    <article
      className={`notice-card notice-card--${tone}`}
      // Standing trouble should be announced when it lands in the open sheet.
      role={!inFlow && tone === "err" ? "alert" : undefined}
    >
      <NoticeHeading tone={tone} title={notice.title} inFlow={inFlow} />
      <p>{notice.body}</p>
      <div className="actions" ref={actions}>
        {notice.open ? (
          // A route of this app, opened in place: the sheet closes with it.
          <IconKey
            label={notice.open.label}
            small
            onClick={() => {
              const to = notice.open?.to;
              onOpen();
              if (to) navigate(to);
            }}
          >
            <IconArrowRight size={16} />
            {inFlow ? (
              <span className="notice-action-label">{notice.open.label}</span>
            ) : null}
          </IconKey>
        ) : null}
        {wordedPair(notice) ? (
          <WordedActs
            notice={notice}
            onOpen={onOpen}
            actionsRef={actions}
            wordedTray={wordedTray}
          />
        ) : act?.worded === true ? (
          <button
            type="button"
            className="btn btn--primary btn--sm choice"
            onClick={pressAct}
          >
            {act.label}
          </button>
        ) : act ? (
          <IconKey label={act.label} small onClick={pressAct}>
            <ActIcon icon={act.icon} />
            {inFlow ? (
              <span className="notice-action-label">{act.label}</span>
            ) : null}
          </IconKey>
        ) : null}
        <NoticeRetry notice={notice} inFlow={inFlow} />
        {notice.ceremony ? (
          // Repair opens as a ceremony sheet in place — never a route change.
          <CeremonyLink id={notice.ceremony}>
            {notice.ceremonyLabel ?? "Repair the connection"}
          </CeremonyLink>
        ) : null}
        <NoticeDismiss notice={notice} inFlow={inFlow} title={dismissTitle} />
      </div>
    </article>
  );
}
