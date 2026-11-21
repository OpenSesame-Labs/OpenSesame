/**
 * Targets and routes the `connectors.external` capability contributes.
 *
 * Nothing here is in the core catalog: the module registers these as
 * `tutorial-target` and `tutorial-route` contributions when it activates, and
 * revokes them when it is disposed, so a plan without connectors has no
 * `nav.connections` for a guide to point at.
 *
 * Descriptions are checked-in prose. Nothing here may interpolate a vault item
 * name, folder name, account address, connection label or any other value a
 * person authored — the whole catalog is handed to a model as page context.
 */

import type { GuideRouteDescriptor } from "./routes.js";
import type { GuideTargetDescriptor } from "./targets.js";

export const CONNECTIONS_TARGETS: readonly GuideTargetDescriptor[] = [
  {
    id: "connections.github.method",
    description:
      "Choose between registering a GitHub App and connecting with a personal access token on the GitHub configuration page.",
    role: "ceremony",
    routes: ["/connections/github", "/settings/connections/github"],
    capabilityId: "connections.create",
  },
  {
    id: "connections.github.backup",
    description:
      "The GitHub page heading and backup switch; a repository must be configured before the switch can enable automatic backups.",
    role: "surface",
    routes: ["/connections/github", "/settings/connections/github"],
    capabilityId: "backup.target.set",
  },
  {
    id: "connections.reload",
    description:
      "Reload the connection list after completing an authorization.",
    role: "action",
    routes: ["/connections"],
    capabilityId: "connections.list",
  },
  {
    id: "connections.connected",
    description: "Review connected providers, their status and settings.",
    role: "surface",
    routes: ["/connections"],
    capabilityId: "connections.list",
  },
  {
    id: "connections.attention",
    description:
      "Review connections that need authorization. This panel appears when a connection is unfinished.",
    role: "status",
    routes: ["/connections"],
    capabilityId: "connections.list",
  },
  {
    id: "connections.catalog",
    description: "Browse providers by category and select one to connect.",
    role: "surface",
    routes: ["/connections"],
    capabilityId: "providers.list",
  },
  {
    id: "connections.provider-picker",
    description: "Search providers by name, category or connector ID.",
    role: "filter",
    routes: ["/connections"],
    capabilityId: "providers.list",
  },
  {
    id: "connections.back",
    description: "Return to the Connections list.",
    role: "navigation",
    routes: ["/connections"],
    capabilityId: null,
  },
  {
    id: "connections.authorize",
    description: "Authorize a provider or review its existing authorization.",
    role: "ceremony",
    routes: ["/connections"],
    capabilityId: "connections.create",
  },
  {
    id: "connections.revoke",
    description:
      "Revoke a connection and request that the provider invalidate its credential. Projects and agents using it lose access.",
    role: "action",
    routes: ["/connections"],
    capabilityId: "connections.remove",
  },
  {
    id: "nav.connections",
    description:
      "Open Connections to add, test and revoke provider connections.",
    role: "navigation",
    routes: [],
    capabilityId: "app.navigate",
  },
];

export const CONNECTIONS_ROUTES: readonly GuideRouteDescriptor[] = [
  {
    id: "/connections",
    title: "Connections — provider connections and their state",
  },
  {
    id: "/connections/git",
    title: "Connections — the generic git remote's own page",
  },
  { id: "/connections/github", title: "Connections — GitHub setup" },
  {
    id: "/settings/connections/github",
    title: "Settings — GitHub setup",
  },
];
