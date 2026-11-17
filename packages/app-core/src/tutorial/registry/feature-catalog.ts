/**
 * One target per section of Settings › Features, so a tutorial can point at
 * the section it is about (`feature-goals.ts`). The heading row is the target
 * — the title and its switch — because that is the part of a section a person
 * looks for, and it stays small however many tiles hang under it. The third
 * party's side of a feature is a section of Settings › Integrations, with its
 * own targets (`integration-catalog.ts`).
 *
 * Scoped to `/settings/features`, not `/settings`: a model is told at most
 * `SUPPORT_LIMITS.maxTargets` controls for the page it is on, and the sections
 * of the page beside this one are not on this one.
 *
 * Authored prose only: a section's title is a constant of the product, never
 * something a person typed.
 */

import type { GuideTargetDescriptor } from "./targets.js";

export const FEATURE_TARGETS: readonly GuideTargetDescriptor[] = [
  {
    id: "feature.identity",
    description: "Enable identity capabilities for sign-in.",
    role: "surface",
    routes: ["/settings/features"],
    capabilityId: null,
  },
  {
    id: "feature.access",
    description:
      "Enable Access for grants, requests, sessions, resources and policies.",
    role: "surface",
    routes: ["/settings/features"],
    capabilityId: null,
  },
  {
    id: "feature.connections",
    description: "Enable Connections and connector grants in Access.",
    role: "surface",
    routes: ["/settings/features"],
    capabilityId: null,
  },
  {
    id: "feature.directory",
    description:
      "Enable directory provisioning for people, agents and devices.",
    role: "surface",
    routes: ["/settings/features"],
    capabilityId: null,
  },
  {
    id: "feature.certificates",
    description:
      "Configure certificate administration when approved by the operator’s plan.",
    role: "surface",
    routes: ["/settings/features"],
    capabilityId: null,
  },
  {
    id: "feature.encrypted-search",
    description:
      "Enable encrypted, searchable history and retired-password databases.",
    role: "surface",
    routes: ["/settings/features"],
    capabilityId: null,
  },
  {
    id: "feature.item-types",
    description:
      "Enable additional built-in item types, including passkeys and certificates.",
    role: "surface",
    routes: ["/settings/features"],
    capabilityId: null,
  },
  {
    id: "feature.environments",
    description:
      "Enable Environment items and generate schemas using references to vault items.",

    role: "surface",
    routes: ["/settings/features"],
    capabilityId: null,
  },
  {
    id: "feature.security-checks",
    description: "Enable breach and two-step checks for vault accounts.",
    role: "surface",
    routes: ["/settings/features"],
    capabilityId: null,
  },
  {
    id: "feature.autofill",
    description: "Manage the companion autofill extension on a paired daemon.",
    role: "surface",
    routes: ["/settings/features"],
    capabilityId: null,
  },
  {
    id: "feature.sharing",
    description: "Enable live sessions and trusted contacts.",
    role: "surface",
    routes: ["/settings/features"],
    capabilityId: null,
  },
  {
    id: "feature.payments",
    description:
      "Enable Wallet, including budgets, payment methods and spending passes.",
    role: "surface",
    routes: ["/settings/features"],
    capabilityId: null,
  },
  {
    id: "feature.ai",
    description:
      "Enable AI features, including local and remote models and WebMCP tools.",
    role: "surface",
    routes: ["/settings/features"],
    capabilityId: null,
  },
  {
    id: "feature.password-reset",
    description: "Enable email accounts and mailbox-assisted password reset.",
    role: "surface",
    routes: ["/settings/features"],
    capabilityId: null,
  },
  {
    id: "feature.surrogates",
    description: "Manage the surrogate proxy on a paired daemon.",
    role: "surface",
    routes: ["/settings/features"],
    capabilityId: null,
  },
  {
    id: "feature.networking",
    description: "Enable networking for this installation.",
    role: "surface",
    routes: ["/settings/features"],
    capabilityId: null,
  },
  {
    id: "feature.notifications",
    description: "Enable Web Push and notification routing.",
    role: "surface",
    routes: ["/settings/features"],
    capabilityId: null,
  },
  {
    id: "feature.local-notifications",
    description:
      "Enable this device’s request list, notification bell and system notifications.",
    role: "surface",
    routes: ["/settings/features"],
    capabilityId: null,
  },
  {
    id: "feature.telemetry",
    description:
      "Enable usage and error telemetry when approved by the operator’s plan.",
    role: "surface",
    routes: ["/settings/features"],
    capabilityId: null,
  },
];
