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
 * A Minimal vault has no password type at all (ADR 0153), so there the first
 * road is the switch that gives it one (`PasswordTypesRoad`, ADR 0221); the
 * guided first password follows once the types are on.
 *
 * Import is the `vault.interop-formats` capability's (ADR 0130), so this
 * offer neither loads it nor owns its sheet: it stands only while that
 * capability's Import command is registered, walks the export, and holds
 * the chosen file for the Import key to read — the same hand-off the front
 * door makes (ADR 0188). The sheet therefore outlives this offer, which is
 * gone the moment the import seals its first item.
 */

import { capabilityPorts } from "@opensesame/app-core/lib/configuration/capabilities-ports.js";
import { guideGoal } from "@opensesame/app-core/tutorial/registry/goals.js";
import type { CapabilityState } from "@opensesame/capability-composition";
import { useCallback, useContext, useState } from "react";
import { Link } from "react-router";
import { useComposition } from "../../bindings/capabilities.js";
import { useContributions } from "../../bindings/contributions.js";
import { FailureNotice } from "../../components/FailureNotice.js";
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

/** The capability that gives the vault its login, card and note types. */
const PASSWORD_TYPES = "vault.derived-records";

/** The three facts of a capability that decide whether its switch is offered. */
export type PasswordTypesState = Pick<
  CapabilityState,
  "distributed" | "permitted" | "approved"
>;

/**
 * Whether this vault has no password type yet and could have one: a Minimal
 * installation, or one whose setup was skipped (ADR 0153), where the plan
 * carries the item types and permits them but nobody has switched them on. A
 * plan that does not ship them, or an operator who withheld them, is not
 * offered a switch it could not honour; nor is a plan that has not resolved.
 */
export function passwordTypesMissing(
  state: PasswordTypesState | undefined,
): boolean {
  return state?.distributed === true && state.permitted && !state.approved;
}

export const firstItemOfferSeams = {
  /** What the plan says of the item types now, or undefined before it resolves. */
  usePasswordTypes: (): PasswordTypesState | undefined =>
    useComposition().plan?.capabilities[PASSWORD_TYPES],
  /**
   * The switch, loaded on the press: it is no part of a vault that already
   * has types. It commits against the composition as it stands at the press.
   */
  turnOnPasswordTypes: async (): Promise<string | null> => {
    const { commitPasswordsOnboarding } = await import(
      "./passwords-onboarding.js"
    );
    return commitPasswordsOnboarding(
      capabilityPorts.compositionStore.getSnapshot(),
    );
  },
};

/**
 * A Minimal vault's first road (ADR 0221): it holds plain secrets only, and a
 * person who came for a password manager finds no password in it. One press
 * switches the item types on — the same commit, with the same consent
 * receipt, as the switch in Settings › Features — and the guided first
 * password takes this road's place.
 */
function PasswordTypesRoad({ createPath }: { createPath: string }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const turnOn = useCallback(() => {
    if (busy) return;
    setBusy(true);
    void firstItemOfferSeams
      .turnOnPasswordTypes()
      .then(setNotice, () => setNotice("Passwords could not be turned on."))
      .finally(() => setBusy(false));
  }, [busy]);
  return (
    <>
      <p className="empty__first-note">
        This vault holds plain secrets and files only. There are no website,
        username and password fields until item types are on.
      </p>
      <button
        type="button"
        className="btn btn--primary choice empty__first-key"
        disabled={busy}
        aria-busy={busy}
        onClick={turnOn}
      >
        Turn on passwords, cards and notes
      </button>
      <Link className="btn btn--ghost choice empty__first-key" to={createPath}>
        Add a plain secret instead
      </Link>
      <FailureNotice
        id="vault:first-run-password-types"
        title="Passwords"
        message={notice}
      />
    </>
  );
}

/** `/vault/new/<kind>`: the kind a narrowed list's New item makes. */
const NAMED_KIND = /^\/vault\/new\/([^/?#]+)/;

/**
 * Both ways in are about passwords, so the offer stands only where New item
 * makes an account: the unfiltered list, or one narrowed to accounts. On a
 * list narrowed to another kind the walkthrough would describe website,
 * username and password fields that its editor does not have.
 */
function makesAccount(createPath: string): boolean {
  const kind = NAMED_KIND.exec(createPath)?.[1];
  return kind === undefined || kind === "account";
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
  const passwordTypes = firstItemOfferSeams.usePasswordTypes();
  const first = guideGoal("vault.item.first");
  const canImport = useContributions("vault-command").some(
    (command) => command.id === "import",
  );
  if (listedCount > 0 || inTrash || !makesAccount(createPath)) return null;
  if (passwordTypesMissing(passwordTypes)) {
    return (
      <div className="empty__first">
        <PasswordTypesRoad createPath={createPath} />
        {canImport ? <GuidedImportOffer /> : null}
      </div>
    );
  }
  return (
    <div className="empty__first">
      {support && first ? (
        <button
          type="button"
          className="btn btn--primary choice empty__first-key"
          onClick={() => void support.startGuide(first.guide, "authored")}
        >
          Add your first password — guided
        </button>
      ) : (
        <Link
          className="btn btn--primary choice empty__first-key"
          to={createPath}
        >
          Add your first password
        </Link>
      )}
      {canImport ? <GuidedImportOffer /> : null}
    </div>
  );
}
