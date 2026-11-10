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
 *
 * Import is the `vault.interop-formats` capability's (ADR 0130), so this
 * offer neither loads it nor owns its sheet: it stands only while that
 * capability's Import command is registered, walks the export, and holds
 * the chosen file for the Import key to read — the same hand-off the front
 * door makes (ADR 0188). The sheet therefore outlives this offer, which is
 * gone the moment the import seals its first item.
 */

import { guideGoal } from "@opensesame/app-core/tutorial/registry/goals.js";
import { useContext } from "react";
import { Link } from "react-router";
import { useContributions } from "../../bindings/contributions.js";
import { useGuidedImport } from "../../screens/unlock/ImportRoad.js";
import { SupportContext } from "../../tutorial/support-context.js";

/** Walk the export, then hold the file for the vault's own Import key. */
function GuidedImportOffer() {
  const guided = useGuidedImport();
  return (
    <>
      <button
        type="button"
        className="btn btn--ghost choice empty__first-key"
        aria-haspopup="dialog"
        onClick={guided.open}
      >
        Import passwords instead
      </button>
      {guided.element}
    </>
  );
}

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
  const canImport = useContributions("vault-command").some(
    (command) => command.id === "import",
  );
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
      {canImport ? <GuidedImportOffer /> : null}
    </div>
  );
}
