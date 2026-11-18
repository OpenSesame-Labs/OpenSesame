/**
 * `enterprise.directory-provisioning`'s panels, as one set its runtime puts
 * in the Identity section's slot (`directory-panel-slot.ts`).
 */

import {
  type ComponentType,
  type LazyExoticComponent,
  Suspense,
  createElement,
  lazy,
} from "react";
import type { DirectoryPanels } from "./directory-panel-slot.js";

function localLazy<Props extends object>(
  component: LazyExoticComponent<ComponentType<Props>>,
): ComponentType<Props> {
  return function DirectoryPanel(props: Props) {
    return createElement(
      Suspense,
      { fallback: null },
      createElement(component, props),
    );
  };
}

const UsersPanel = localLazy(
  lazy(() =>
    import("./UsersPanel.js").then((module) => ({
      default: module.UsersPanel,
    })),
  ),
);
const AgentsPanel = localLazy(
  lazy(() =>
    import("./AgentsPanel.js").then((module) => ({
      default: module.AgentsPanel,
    })),
  ),
);
const DirectoryDevices = localLazy(
  lazy(() =>
    import("./DevicesPanel.js").then((module) => ({
      default: module.DirectoryDevices,
    })),
  ),
);
const OrgSignInPanels = localLazy(
  lazy(() =>
    import("./org-signin/OrgSignInPanels.js").then((module) => ({
      default: module.OrgSignInPanels,
    })),
  ),
);

export const DIRECTORY_PANELS: DirectoryPanels = {
  People: UsersPanel,
  Agents: AgentsPanel,
  Devices: DirectoryDevices,
  OrgSignIn: OrgSignInPanels,
};
