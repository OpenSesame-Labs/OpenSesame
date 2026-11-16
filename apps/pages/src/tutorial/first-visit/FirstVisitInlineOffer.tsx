import { resolveGuideTargetElement } from "@opensesame/app-core/tutorial/registry/targets.js";
import { createPortal } from "react-dom";
import { FormCommit } from "../../components/FormCommit.js";
import { IconPlay } from "../../components/Icons.js";

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
  const finish = (action: () => void) => {
    if (offer.host.contains(document.activeElement)) {
      const target = offer.host.dataset.firstVisitReturn;
      if (target) {
        resolveGuideTargetElement(target)
          ?.querySelector<HTMLElement>(
            "input:not(:disabled), button:not(:disabled)",
          )
          ?.focus();
      }
    }
    onClose();
    action();
  };
  return createPortal(
    <aside className="panel" aria-label={`${offer.title} walkthrough`}>
      <div className="panel__body">
        <p>
          <strong>{offer.title}.</strong> {body}
        </p>
        <FormCommit
          label="Show me"
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
