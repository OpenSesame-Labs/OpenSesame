import type { ToastMessage } from "@opensesame/app-core/lib/notice-toast.js";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { keyboardIsIdle, landFocus } from "../lib/focus.js";
import { useModalFocus } from "../lib/modal-focus.js";
import { IconKey } from "./IconKey.js";
import { IconAlert, IconInfo, IconX } from "./Icons.js";
import { dismissContext } from "./notice-dismiss-context.js";
import "./inline-recommendations.css";

type Actions = {
  onDone: (id: string) => void;
  onOpen: (to: string) => void;
};

function useRecommendationFocus(
  ids: string,
  active: boolean,
  reviewing: boolean,
  region: React.RefObject<HTMLOutputElement | null>,
  sheet: React.RefObject<HTMLDivElement | null>,
  closeKey: React.RefObject<HTMLButtonElement | null>,
) {
  const before = useRef<Element | null>(document.activeElement);
  const lastInside = useRef<Element | null>(null);
  useEffect(() => {
    const remember = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (region.current?.contains(target) || sheet.current?.contains(target)) {
        lastInside.current = target;
      } else {
        before.current = target;
        lastInside.current = null;
      }
    };
    document.addEventListener("focusin", remember);
    return () => document.removeEventListener("focusin", remember);
  }, [region, sheet]);

  // Only a focused control that actually disappeared needs a new home.
  // biome-ignore lint/correctness/useExhaustiveDependencies: ids tracks card removal
  useLayoutEffect(() => {
    if (!active) {
      lastInside.current = null;
    } else if (
      lastInside.current &&
      !lastInside.current.isConnected &&
      keyboardIsIdle()
    ) {
      if (reviewing) landFocus(closeKey.current);
      else landFocus(before.current);
    }
  }, [ids, active]);
}

/** Persistent arrivals are previewed in flow; Review shows the whole offer. */
export function InlineRecommendations({
  items,
  active,
  onDone,
  onOpen,
}: Actions & { items: readonly ToastMessage[]; active: boolean }) {
  const [open, setOpen] = useState(false);
  const region = useRef<HTMLOutputElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const closeKey = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const showing = active && items.length > 0;
  const reviewing = showing && open;
  const ids = items.map((item) => item.id).join("\0");

  useRecommendationFocus(ids, active, reviewing, region, sheet, closeKey);
  useEffect(() => {
    if (!showing) setOpen(false);
  }, [showing]);
  useModalFocus(reviewing, sheet, closeKey, close);

  const dismiss = (item: ToastMessage) => {
    onDone(item.id);
    item.onDismiss?.();
  };
  return (
    <>
      <output
        className="recommendation-region"
        aria-label="Recommendations"
        aria-live="polite"
        ref={region}
      >
        {showing ? (
          <div className="recommendation-preview">
            <strong>
              {items.length === 1
                ? `Recommendation: ${items[0]?.compactTitle?.trim() || items[0]?.title}`
                : `${items.length} recommendations`}
            </strong>
            <button
              type="button"
              className="btn btn--sm choice"
              aria-haspopup="dialog"
              aria-label={
                items.length === 1
                  ? `Review ${items[0]?.title}`
                  : `Review ${items.length} recommendations`
              }
              onClick={() => setOpen(true)}
            >
              Review
            </button>
            {items.length === 1 && items[0] ? (
              <button
                type="button"
                className="btn btn--sm btn--ghost notice-dismiss"
                aria-label={`Dismiss recommendation: ${items[0].title}`}
                onClick={() => items[0] && dismiss(items[0])}
              >
                Dismiss
              </button>
            ) : null}
          </div>
        ) : null}
      </output>
      {reviewing
        ? createPortal(
            <RecommendationReview
              items={items}
              sheet={sheet}
              closeKey={closeKey}
              onClose={close}
              onDone={onDone}
              onOpen={onOpen}
            />,
            document.body,
          )
        : null}
    </>
  );
}

function RecommendationReview({
  items,
  sheet,
  closeKey,
  onClose,
  onDone,
  onOpen,
}: Actions & {
  items: readonly ToastMessage[];
  sheet: React.RefObject<HTMLDivElement | null>;
  closeKey: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  return (
    <div className="sheet-layer">
      <button
        type="button"
        className="scrim"
        aria-label="Close"
        onClick={onClose}
      />
      <div
        ref={sheet}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Recommendations"
      >
        <div className="sheet__head">
          <div className="sheet__grow">
            <h2>Recommendations</h2>
          </div>
          <IconKey label="Close" keyRef={closeKey} onClick={onClose}>
            <IconX size={18} />
          </IconKey>
        </div>
        <div className="sheet__body">
          {items.map((item) => (
            <RecommendationCard
              key={item.id}
              item={item}
              dismissContext={dismissContext(item, items)}
              onClose={onClose}
              onDone={onDone}
              onOpen={onOpen}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function RecommendationCard({
  item,
  dismissContext,
  onClose,
  onDone,
  onOpen,
}: Actions & {
  item: ToastMessage;
  dismissContext: string;
  onClose: () => void;
}) {
  const finish = (action: () => void, dismiss = false) => {
    if (!dismiss) onClose();
    onDone(item.id);
    action();
  };
  return (
    <article className={`notice-card notice-card--${item.tone}`}>
      <h3>
        {item.tone === "info" ? (
          <IconInfo size={16} />
        ) : (
          <IconAlert size={16} />
        )}
        {item.title}
      </h3>
      <p>{item.body}</p>
      <div className="actions">
        {item.choice ? (
          <button
            type="button"
            className="btn btn--primary btn--sm choice toast__choice"
            onClick={() => finish(() => item.choice?.run())}
          >
            {item.choice.label}
          </button>
        ) : null}
        {item.alt ? (
          <button
            type="button"
            className="btn btn--sm choice"
            onClick={() => finish(() => item.alt?.run())}
          >
            {item.alt.label}
          </button>
        ) : null}
        {item.open ? (
          <button
            type="button"
            className="btn btn--sm choice"
            onClick={() => finish(() => item.open && onOpen(item.open.to))}
          >
            {item.open.label}
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn--sm btn--ghost notice-dismiss"
          aria-label={`Dismiss recommendation: ${dismissContext}`}
          onClick={() => finish(() => item.onDismiss?.(), true)}
        >
          Dismiss
        </button>
      </div>
    </article>
  );
}
