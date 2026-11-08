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
  if (listedCount > 0 || inTrash) return null;
  return (
    <div className="empty__first">
      {support && first ? (
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
      <GuidedImportButton className="btn btn--ghost choice empty__first-key">
        Import passwords instead
      </GuidedImportButton>
    </div>
  );
}
