/**
 * Settings › Integrations — what this installation connects to.
 *
 * The panel chrome (head, title) belongs to Vault Settings. The list itself
 * is `IntegrationsBody`, which setup also draws without this chrome or the
 * vault shell. A connector is configured by reference on its own page, so
 * nothing here is switched, reviewed or waits on a feature being on (ADR
 * 0189). The switches are Settings › Features.
 */

import { IntegrationsBody } from "./IntegrationsBody.js";
import "./capabilities.css";

export function IntegrationsPanel() {
  return (
    <section className="panel" data-testid="integrations-panel">
      <div className="panel__head capspanel__head">
        <h2>Integrations</h2>
      </div>
      <IntegrationsBody />
    </section>
  );
}
