import {
  FEATURES,
  isSwitchable,
} from "@opensesame/app-core/lib/capabilities/features.js";
import { INTEGRATIONS } from "@opensesame/app-core/lib/capabilities/integrations.js";
import { compositionStore } from "@opensesame/app-core/lib/capabilities/store.js";
import { connectorTile } from "@opensesame/app-core/lib/connect-roads.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import type { LibraryOptions } from "@opensesame/app-core/tutorial/registry/areas.js";
import {
  provideGuideDeviceForm,
  provideGuideInstallOffer,
  provideGuideSupportModelPicks,
  registerGuidePredicates,
} from "@opensesame/app-core/tutorial/registry/predicates.js";
import { readGuidePredicate } from "@opensesame/app-core/tutorial/registry/state.js";
import { integrationDraws } from "../sections/settings/provider-tile-items.js";
import { installState } from "./install.js";
import { installPanelDraws } from "./install-panel.js";
import { finePointerNow, narrowNow } from "./use-narrow.js";

/** Same offer gate as the Ask and Tutorials tabs, without React hooks. */
export function buildTutorialGateOptions(identityApi = true): LibraryOptions {
  const plan = compositionStore.getSnapshot().plan;
  const { status, guest, tomb } = vaultStore.getSnapshot();
  const sealedVault = status === "unlocked" && !guest && Boolean(tomb);
  const tileRoad = (provider: { id: string }) =>
    connectorTile(provider, sealedVault);
  registerGuidePredicates();
  provideGuideInstallOffer(() => installPanelDraws(installState()));
  provideGuideDeviceForm(() => ({
    narrow: narrowNow(),
    keys: finePointerNow(),
  }));
  provideGuideSupportModelPicks(
    () => plan?.capabilities["support.local-ai"]?.approved === true,
  );
  const drawn = new Set(
    FEATURES.filter((feature) =>
      isSwitchable(feature, plan, { identityApi }),
    ).map((feature) => `feature.${feature.id}`),
  );
  for (const integration of INTEGRATIONS) {
    if (integration.id === "ai" || integrationDraws(integration, tileRoad)) {
      drawn.add(`integration.${integration.id}`);
    }
  }
  return {
    sectionDrawn: (id: string) => drawn.has(id),
    holds: readGuidePredicate,
    installed: (id: string) => plan?.capabilities[id]?.approved === true,
  };
}
