/**
 * Settings › Features — which optional parts of this installation are on.
 *
 * The panel chrome (head, title) belongs to Vault Settings. The list itself
 * is `FeaturesBody`, which setup also draws without this chrome or the vault
 * shell. Guests first; then identity, access, the vault's extras, sharing,
 * payments, AI, networking, notifications and telemetry; then, for the
 * operator of this device, the instance policy (`InstancePolicyLink`, never
 * shown to a member — SURFACE-06).
 *
 * The documents behind the page — the selection, the operator's policy, the
 * effective plan — are files beside this directory's `config.yaml`
 * (`capability-files.ts`), and this page is how each of them is seen. The
 * services a feature connects to are on Settings › Integrations (ADR 0189).
 */

import { FeaturesBody } from "./FeaturesBody.js";
import "./capabilities.css";

export { capabilitiesPanelSeams } from "./useCapabilityChange.js";

export function FeaturesPanel() {
  return (
    <section className="panel" data-testid="features-panel">
      <div className="panel__head capspanel__head">
        <h2>Features</h2>
      </div>
      <FeaturesBody />
    </section>
  );
}
