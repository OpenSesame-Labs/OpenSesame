/**
 * `enterprise.directory-provisioning`'s panels, as one set its runtime puts
 * in the Identity section's slot (`directory-panel-slot.ts`).
 */

import {
  type ComponentProps,
  type ComponentType,
  type LazyExoticComponent,
  Suspense,
  createElement,
  lazy,
} from "react";
import type { DirectoryPanels } from "./directory-panel-slot.js";

function renderLazy<Props extends object>(
  component: LazyExoticComponent<ComponentType<Props>>,
  props: Props,
) {
  return createElement(
    Suspense,
    { fallback: null },
    createElement(component, props),
  );
}

const LazyUsersPanel = lazy(() =>
  import("./UsersPanel.js").then((module) => ({
    default: module.UsersPanel,
  })),
);
const LazyAgentsPanel = lazy(() =>
  import("./AgentsPanel.js").then((module) => ({
    default: module.AgentsPanel,
  })),
);
const LazyDirectoryDevices = lazy(() =>
  import("./DevicesPanel.js").then((module) => ({
    default: module.DirectoryDevices,
  })),
);
const LazyOrgSignInPanels = lazy(() =>
  import("./org-signin/OrgSignInPanels.js").then((module) => ({
    default: module.OrgSignInPanels,
  })),
);

function UsersPanel(props: ComponentProps<typeof LazyUsersPanel>) {
  return renderLazy(LazyUsersPanel, props);
}
function AgentsPanel(props: ComponentProps<typeof LazyAgentsPanel>) {
  return renderLazy(LazyAgentsPanel, props);
}
function DirectoryDevices(props: ComponentProps<typeof LazyDirectoryDevices>) {
  return renderLazy(LazyDirectoryDevices, props);
}
function OrgSignInPanels(props: ComponentProps<typeof LazyOrgSignInPanels>) {
  return renderLazy(LazyOrgSignInPanels, props);
}

export const DIRECTORY_PANELS: DirectoryPanels = {
  People: UsersPanel,
  Agents: AgentsPanel,
  Devices: DirectoryDevices,
  OrgSignIn: OrgSignInPanels,
};
