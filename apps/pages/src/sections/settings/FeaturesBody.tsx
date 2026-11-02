/**
 * The Features tab body — sections, switches, and the operator's policy link.
 *
 * Settings › Features draws this inside the panel chrome. Setup draws this
 * alone, with no vault shell, settings tab strip, or panel head (ADR 0189).
 * A switch commits in place (`useCapabilityChange`). Failures are a
 * `StatusMark` and a `FailureNotice`, never an in-page error box.
 */

import { withdrawnAlwaysOn } from "@opensesame/app-core/lib/capabilities/features.js";
import { capabilityPorts } from "@opensesame/app-core/lib/configuration/capabilities-ports.js";
import { FailureNotice } from "../../components/FailureNotice.js";
import { IconRefresh } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { FeatureSections } from "./FeatureSections.js";
import { InstancePolicyLink } from "./InstanceCapabilitiesPanel.js";
import {
  type CapabilityChange,
  capabilitiesPanelSeams,
  useCapabilityChange,
} from "./useCapabilityChange.js";
import "./capabilities.css";

function RestartNotice({ change }: { change: CapabilityChange }) {
  const pending = Object.values(change.snapshot.plan?.capabilities ?? {}).some(
    (state) => state.restartRequired,
  );
  if (!pending) return null;
  return (
    <p className="capspanel__notice" data-testid="capabilities-restart">
      <StatusMark tone="warn" label="restart required" />
      <span>reload to finish unloading</span>
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        aria-label="Reload now"
        title="Reload now"
        onClick={() => capabilitiesPanelSeams.reload()}
      >
        <IconRefresh size={14} />
      </button>
    </p>
  );
}

/**
 * Always-on capabilities this plan does not run: an operator withdrew them
 * (ADR 0142), or they need one that was. Named here, and marked on the
 * section they back, rather than drawn as though they ran.
 */
function WithdrawnNotice({ change }: { change: CapabilityChange }) {
  const withdrawn = withdrawnAlwaysOn(change.snapshot.plan);
  if (withdrawn.length === 0) return null;
  const titles = withdrawn
    .map(
      (id) =>
        capabilityPorts.CAPABILITY_CATALOG.capabilities.find(
          (entry) => entry.id === id,
        )?.title ?? id,
    )
    .join(", ");
  const label = `withdrawn by operator: ${titles}`;
  return (
    <p className="capspanel__notice" data-testid="capabilities-withdrawn">
      <StatusMark tone="err" label={label} />
      <span>{label}</span>
    </p>
  );
}

function Sections({ change }: { change: CapabilityChange }) {
  return (
    <>
      <FeatureSections current={change.current} onPropose={change.propose} />
      <InstancePolicyLink />
    </>
  );
}

/** The Features list, without Settings' panel head or the vault shell. */
export function FeaturesBody() {
  const change = useCapabilityChange();
  return (
    <div className="panel__body capspanel" data-testid="features-body">
      <RestartNotice change={change} />
      <WithdrawnNotice change={change} />
      {change.notice ? <StatusMark tone="err" label={change.notice} /> : null}
      <FailureNotice
        id="settings:features"
        title="Features"
        message={change.notice}
      />
      <Sections change={change} />
    </div>
  );
}
