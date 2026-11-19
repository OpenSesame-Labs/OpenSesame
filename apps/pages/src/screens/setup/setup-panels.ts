import type { ComponentType } from "react";
import { useCompositionContributions } from "../../bindings/capabilities.js";
import { CapabilitySetup } from "../capabilities/CapabilitySetup.js";

/** One tab: the fixed capabilities tab, or a `setup-panel` contribution. */
export type SetupPanel = Readonly<{
  id: string;
  tab: string;
  rail: string;
  Panel: ComponentType;
  order?: number;
}>;

export const CAPABILITIES_STEP = "capabilities";

export function useContributedPanels(): readonly SetupPanel[] {
  return useCompositionContributions("setup-panel").map((entry) => ({
    id: entry.id,
    tab: entry.tab,
    rail: entry.rail,
    Panel: entry.Panel,
    order: entry.order,
  }));
}

export function baseSetupPanels(
  contributed: readonly SetupPanel[],
): readonly SetupPanel[] {
  return [
    {
      id: CAPABILITIES_STEP,
      tab: CAPABILITIES_STEP,
      rail: "Capabilities",
      Panel: CapabilitySetup,
    },
    ...[...contributed].sort(
      (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id),
    ),
  ];
}