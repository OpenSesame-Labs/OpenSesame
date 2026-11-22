/**
 * One target per section of Settings › Integrations, so a tutorial can point
 * at the section it is about (`integration-goals.ts`). An integration is a
 * third party a feature connects to, configured by reference on the
 * connector's own page, so unlike a feature section it carries no switch. The
 * heading row is the target, and it stays small however many tiles hang under
 * it. The switches are sections of Settings › Features
 * (`feature-catalog.ts`).
 *
 * Scoped to `/settings/integrations`, not `/settings`, for the same reason as
 * the feature sections: the model's per-page target budget.
 *
 * Authored prose only: a section's title is a constant of the product, never
 * something a person typed.
 */

import type { GuideTargetDescriptor } from "./targets.js";

export const INTEGRATION_TARGETS: readonly GuideTargetDescriptor[] = [
  {
    id: "integration.services",
    description:
      "Configure developer APIs, productivity, communication, storage and CRM services.",
    role: "surface",
    routes: ["/settings/integrations"],
    capabilityId: null,
  },
  {
    id: "integration.identity",
    description: "Configure identity providers for sign-in.",
    role: "surface",
    routes: ["/settings/integrations"],
    capabilityId: null,
  },
  {
    id: "integration.encryption",
    description:
      "Configure cloud key services, hardware keys and age recipients by reference.",
    role: "surface",
    routes: ["/settings/integrations"],
    capabilityId: null,
  },
  {
    id: "integration.certificates",
    description: "Configure certificate authorities by reference.",
    role: "surface",
    routes: ["/settings/integrations"],
    capabilityId: null,
  },
  {
    id: "integration.backups",
    description: "Configure a git provider for encrypted vault backups.",
    role: "surface",
    routes: ["/settings/integrations"],
    capabilityId: null,
  },
  {
    id: "integration.password-managers",
    description: "Configure password manager integrations by reference.",
    role: "surface",
    routes: ["/settings/integrations"],
    capabilityId: null,
  },
  {
    id: "integration.cloud-secret-storage",
    description: "Configure cloud secret stores by reference.",
    role: "surface",
    routes: ["/settings/integrations"],
    capabilityId: null,
  },
  {
    id: "integration.payments",
    description:
      "Configure card issuers and wallet-pass providers by reference.",
    role: "surface",
    routes: ["/settings/integrations"],
    capabilityId: null,
  },
  {
    id: "integration.password-reset",
    description:
      "Configure computer-use runtimes for password reset. Model providers are under AI.",
    role: "surface",
    routes: ["/settings/integrations"],
    capabilityId: null,
  },
  {
    id: "integration.ai",
    description:
      "Connect agent harnesses and AI model providers. Choose models under Settings → Features → AI.",
    role: "surface",
    routes: ["/settings/integrations"],
    capabilityId: null,
  },
  {
    id: "integration.networking",
    description: "Configure tailnet providers by reference.",
    role: "surface",
    routes: ["/settings/integrations"],
    capabilityId: null,
  },
];
