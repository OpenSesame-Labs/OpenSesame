/**
 * The Integrations tab body — third-party sections, without Settings chrome.
 *
 * Settings › Integrations draws this inside the panel head. Setup draws this
 * alone, with no vault shell, settings tab strip, or panel title (ADR 0189).
 * A connector is configured by reference on its own page, so nothing here is
 * switched or reviewed.
 */

import { IntegrationSections } from "./IntegrationSections.js";
import "./capabilities.css";

/** The Integrations list, without Settings' panel head or the vault shell. */
export function IntegrationsBody() {
  return (
    <div className="panel__body capspanel" data-testid="integrations-body">
      <IntegrationSections />
    </div>
  );
}
