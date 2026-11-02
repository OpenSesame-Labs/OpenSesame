/**
 * Features and Integrations inside the setup ceremony.
 *
 * Fixed tabs, not capability contributions: every installation has them, and
 * they draw the settings tab bodies alone. The vault shell stays unmounted
 * until setup finishes.
 */

import type { SetupPanel } from "../SetupScreen.js";
import { FeaturesStep } from "./steps/FeaturesStep.js";
import { IntegrationsStep } from "./steps/IntegrationsStep.js";

export const FEATURES_STEP = "features";
export const INTEGRATIONS_STEP = "integrations";

/** Where a committed preset opens: the Features body, or the first tab. */
export function featuresStepIndex(steps: readonly { id: string }[]): number {
  const at = steps.findIndex((step) => step.id === FEATURES_STEP);
  return at < 0 ? 0 : at;
}

export function settingsSetupSteps(): readonly SetupPanel[] {
  return [
    {
      id: FEATURES_STEP,
      tab: FEATURES_STEP,
      rail: "Features",
      Panel: FeaturesStep,
    },
    {
      id: INTEGRATIONS_STEP,
      tab: INTEGRATIONS_STEP,
      rail: "Integrations",
      Panel: IntegrationsStep,
    },
  ];
}
