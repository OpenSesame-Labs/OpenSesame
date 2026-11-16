import {
  INTEGRATIONS,
  type Integration,
} from "@opensesame/app-core/lib/capabilities/integrations.js";
import { useMemo } from "react";
import { useConnectorRoads } from "../../bindings/connector-roads.js";
import { integrationDraws } from "./provider-tile-items.js";

export type DrawnIntegration = Readonly<{
  integration: Integration;
}>;

/**
 * The integrations that draw on this device, by the rule the page draws them
 * by. The page, the rail, the phone's page index and the tutorial gate all
 * start here, so none lists a section the page leaves out.
 */
export function useIntegrationsDrawn(): readonly DrawnIntegration[] {
  const roads = useConnectorRoads();
  const visibleIds = INTEGRATIONS.filter(
    (integration) =>
      integration.id === "ai" || integrationDraws(integration, roads.tile),
  )
    .map((integration) => integration.id)
    .join("|");
  return useMemo(() => {
    const visible = new Set(visibleIds.split("|"));
    return INTEGRATIONS.filter((integration) =>
      visible.has(integration.id),
    ).map((integration) => ({ integration }));
  }, [visibleIds]);
}
