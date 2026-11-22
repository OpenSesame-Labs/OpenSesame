import { resolveGuideTargetElement } from "@opensesame/app-core/tutorial/registry/targets.js";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { FormCommit } from "../../components/FormCommit.js";
import { IconPlay } from "../../components/Icons.js";
import { landFocus } from "../../lib/focus.js";

export type InlineOffer = Readonly<{
  host: HTMLElement;
  route: string;
  title: string;
  steps: number;
  start: () => void;
  dismiss: () => void;
}>;

export function FirstVisitInlineOffer({
  offer,
  body,
  onClose,
}: {
  offer: InlineOffer;
  body: string;
  onClose: () => void;
}) {
  const before = useRef<Element | null>(document.activeElement);
  useEffect(() => {
    const remember = (event: FocusEvent) => {
      if (event.target instanceof Element && !offer.host.contains(event.target))
        before.current = event.target;
    };
    document.addEventListener("focusin", remember);
    return () => document.removeEventListener("focusin", remember);
  }, [offer.host]);
  const finish = (action: () => void) => {
    if (offer.host.contains(document.activeElement)) {
      const target = offer.host.dataset.firstVisitReturn;
      const guide = target ? resolveGuideTargetElement(target) : null;
      const control = guide?.matches(
        "input:not(:disabled), button:not(:disabled)",
      )
        ? guide
        : guide?.querySelector("input:not(:disabled), button:not(:disabled)");
      if (!landFocus(control)) landFocus(before.current);
    }
    onClose();
    action();
  };
  return createPortal(
    <aside
      className="panel"
      aria-label={`${offer.title} walkthrough`}
      onFocusCapture={(event) => {
        if (
          event.relatedTarget instanceof Element &&
          !event.currentTarget.contains(event.relatedTarget)
        )
          before.current = event.relatedTarget;
      }}
    >
      <div className="panel__body">
        <p>
          <strong>Walkthrough: {offer.title}.</strong> {body}
        </p>
        <FormCommit
          label="Start tutorial"
          icon={<IconPlay size={18} />}
          onClick={() => finish(offer.start)}
        >
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => finish(offer.dismiss)}
          >
            Not now
          </button>
        </FormCommit>
      </div>
    </aside>,
    offer.host,
  );
}
