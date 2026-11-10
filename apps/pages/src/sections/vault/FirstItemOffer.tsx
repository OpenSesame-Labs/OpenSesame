/**
 * A truly empty vault's first-run offer: the one moment the empty state
 * carries acting keys (DESIGN.md § Empty states, first-run carve-out),
 * because there is no list to act on yet and the app is new to the person
 * looking at it.
 *
 * Two ways in, both real roads that already exist: the guided walkthrough
 * that adds a first password step by step, and the guided import for
 * passwords a browser already holds. Nothing starts on its own — the
 * offer is the initialization, and the press is the consent (ADR 0163:
 * nothing remembers a tour was run, so the offer simply stands while the
 * vault is empty and is gone once anything is sealed).
 */

import { guideGoal } from "@opensesame/app-core/tutorial/registry/goals.js";
import { useContext } from "react";
import { Link } from "react-router";
import { SupportContext } from "../../tutorial/support-context.js";
import { GuidedImportButton } from "./import/ImportKey.js";

export function FirstItemOffer({
  createPath,
  listedCount,
  inTrash,
}: {
  createPath: string;
  /** Everything sealed, trash included: the offer stands only at zero. */
  listedCount: number;
  inTrash: boolean;
}) {
  const support = useContext(SupportContext);
  const first = guideGoal("vault.item.first");
  const finished = listedCount > 0 || inTrash;
  // The import button stays mounted after the offer is spent: it owns the
  // import sheet, and a successful import is exactly what makes the vault
  // non-empty — unmounting with the offer would take the sheet's
  // completion screen (and its Done action) with it. Only its trigger
  // key goes away.
  return (
    <div
      className={finished ? "empty__first empty__first--spent" : "empty__first"}
    >
      {finished ? null : support && first ? (
        <button
          type="button"
          className="btn choice empty__first-key"
          onClick={() => void support.startGuide(first.guide, "authored")}
        >
          Add your first password — guided
        </button>
      ) : (
        <Link className="btn choice empty__first-key" to={createPath}>
          Add your first password
        </Link>
      )}
      <GuidedImportButton
        triggerHidden={finished}
        className="btn btn--ghost choice empty__first-key"
      >
        Import passwords instead
      </GuidedImportButton>
    </div>
  );
}
