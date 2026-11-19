/**
 * Targets and routes the `identity.*` capabilities contribute (federation,
 * local IAM, SIOP). Registered as `tutorial-target` and `tutorial-route`
 * contributions on activation; absent on a plan without them.
 */

import type { GuideRouteDescriptor } from "./routes.js";
import type { GuideTargetDescriptor } from "./targets.js";

export const IDENTITY_TARGETS: readonly GuideTargetDescriptor[] = [
  // ── Identity administration ─────────────────────────────────────────
  {
    id: "identity.agents",
    description: "Register, rename or revoke agent registrations you own.",
    role: "navigation",
    routes: ["/identity"],
    capabilityId: "identity.agent.register",
  },
  {
    id: "identity.people",
    description:
      "Review your identity, linked identities, access and organization members.",
    role: "navigation",
    routes: ["/identity"],
    capabilityId: "identity.whoami",
  },
  {
    id: "identity.providers",
    description: "Review identity providers registered for this deployment.",
    role: "navigation",
    routes: ["/identity"],
    capabilityId: "identity.admin",
  },
  {
    id: "identity.devices",
    description:
      "Review browsers and installations that unlocked this vault, and tailnet devices when a daemon is paired.",
    role: "navigation",
    routes: ["/identity"],
    capabilityId: "identity.device.approve",
  },
  {
    id: "identity.service-accounts",
    description:
      "Register OIDC applications, manage redirect URIs and revoke registrations.",
    role: "navigation",
    routes: ["/identity"],
    capabilityId: "identity.admin",
  },
  {
    id: "identity.organization",
    description: "Review the current organization and its settings.",
    role: "navigation",
    routes: ["/identity"],
    capabilityId: "identity.admin",
  },
  {
    id: "identity.org-signin",
    description:
      "Review the organization’s sign-in provider, email domains and provisioning tokens. Only an owner can change them.",
    role: "action",
    routes: ["/identity"],
    capabilityId: "identity.org_signin.upstream.manage",
  },
  {
    id: "identity.register-idp",
    description:
      "Register an identity provider using a preset or a custom OIDC issuer.",
    role: "ceremony",
    routes: ["/identity"],
    capabilityId: "identity.admin",
  },

  {
    id: "nav.identity",
    description:
      "Open Identity to manage accounts, providers and linked identities.",
    role: "navigation",
    routes: [],
    capabilityId: "app.navigate",
  },
];

export const IDENTITY_ROUTES: readonly GuideRouteDescriptor[] = [
  { id: "/federation", title: "Federation return — finish a sign-in" },
  {
    id: "/identity/authorize",
    title: "Local application — review a sign-in request",
  },
  {
    id: "/identity",
    title: "Identity — accounts, providers and linked identities",
  },
];
