/**
 * Targets and routes the `access.authority` capability contributes.
 *
 * Registered as `tutorial-target` and `tutorial-route` contributions when the
 * module activates; absent from every catalog view on a plan without it.
 *
 * Descriptions are checked-in prose. Nothing here may interpolate a vault item
 * name, folder name, account address or any other value a person authored —
 * the whole catalog is handed to a model as page context.
 */

import type { GuideRouteDescriptor } from "./routes.js";
import type { GuideTargetDescriptor } from "./targets.js";

export const ACCESS_TARGETS: readonly GuideTargetDescriptor[] = [
  {
    id: "access.grants",
    description:
      "Review application grants, delegations, scope and expiration. Revoke a grant after confirmation.",
    role: "navigation",
    routes: ["/access"],
    capabilityId: "delegations.list",
  },
  {
    id: "access.requests",
    description:
      "Review authorization requests awaiting a decision and offers created by this deployment.",
    role: "navigation",
    routes: ["/access"],
    capabilityId: "relay.inbox",
  },
  {
    id: "access.sessions",
    description: "Review or end agent tasks running on this device.",
    role: "navigation",
    routes: ["/access"],
    capabilityId: "tasks.list",
  },
  {
    id: "access.connectors",
    description:
      "Review connector grants. Select Add to choose a configured connector, recipient, policy and expiration.",
    role: "navigation",
    routes: ["/access"],
    capabilityId: "connectors.bind",
  },
  {
    id: "access.resources",
    description: "Review connections and registered sites available to grants.",
    role: "navigation",
    routes: ["/access"],
    capabilityId: "connections.list",
  },
  {
    id: "access.policies",
    description:
      "Review policies that control how authorizations can be delegated and used.",
    role: "navigation",
    routes: ["/access"],
    capabilityId: "connections.update",
  },
  {
    id: "access.grant-access",
    description:
      "Select Add in Identity shares to choose a recipient, resource, policy and duration.",
    role: "ceremony",
    routes: ["/access"],
    capabilityId: "connectors.bind",
  },
  {
    id: "access.grant-ceremony",
    description:
      "Choose the recipient, resource, policy and duration for a share.",
    role: "ceremony",
    routes: ["/access"],
    capabilityId: "connectors.bind",
  },
  {
    id: "access.relay",
    description: "Review pending relay requests and approve or deny each one.",
    role: "ceremony",
    routes: ["/access"],
    capabilityId: "relay.decide",
  },
  {
    id: "nav.access",
    description: "Open Access to review delegations, offers and agent tasks.",
    role: "navigation",
    routes: [],
    capabilityId: "app.navigate",
  },
];

export const ACCESS_ROUTES: readonly GuideRouteDescriptor[] = [
  { id: "/access", title: "Access — delegations, offers and running tasks" },
  { id: "/access/shares", title: "Access — identity shares" },
  { id: "/access/requests", title: "Access — requests waiting on a decision" },
  {
    id: "/access/resources",
    title: "Access — resources available to grants",
  },
  {
    id: "/access/policies",
    title: "Access — application policies",
  },
];
