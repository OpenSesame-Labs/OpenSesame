/**
 * The authored target catalog — every control a support guide may point at.
 *
 * These names are the vocabulary the model gets, and they are chosen the way a
 * person would describe the app rather than the way it happens to be built:
 * `nav.connections`, not `.railtree__row:nth-child(2)`. That is what lets the
 * UI be restyled or rebuilt without silently invalidating every tutorial.
 *
 * Descriptions are checked-in prose. Nothing here may interpolate a vault item
 * name, folder name, account address, connection label or any other value a
 * person authored — the whole catalog is handed to a model as page context.
 */

import { contributionsSnapshot } from "../../lib/contributions.js";
import { GUIDE_TARGETS_MORE } from "./catalog-more.js";
import { FEATURE_TARGETS } from "./feature-catalog.js";
import { INTEGRATION_TARGETS } from "./integration-catalog.js";
import { SHELL_TARGETS } from "./shell-catalog.js";
import type { GuideTargetDescriptor } from "./targets.js";
import { VAULT_TARGETS } from "./vault-catalog.js";

/**
 * The targets the core shell always has. Every other control belongs to the
 * capability that draws it and arrives as a `tutorial-target` contribution
 * while that capability is in the plan (`connections-catalog.ts`,
 * `access-catalog.ts`, `identity-catalog.ts`, `wallet-catalog.ts`,
 * `activity-catalog.ts`); `authored.ts` is the whole corpus for a module to
 * pick its entries from.
 */
export const CORE_GUIDE_TARGETS: readonly GuideTargetDescriptor[] = [
  ...SHELL_TARGETS,
  ...VAULT_TARGETS,
  ...FEATURE_TARGETS,
  ...INTEGRATION_TARGETS,

  // ── Settings: seven categories and the panels people ask about ─────────
  {
    id: "settings.general",
    description: "Change appearance and automatic locking preferences.",
    role: "navigation",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "settings.keybindings",
    description:
      "Change keyboard shortcuts and manage macros for commands and events.",
    role: "navigation",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "settings.security",
    description:
      "Manage vault unlock methods, second steps and recovery codes.",
    role: "navigation",
    routes: ["/settings"],
    capabilityId: null,
  },
  // Settings › Features and Settings › Integrations draw these in core, before
  // any module lands. Each category stands for its list by its first section.
  {
    id: "settings.features-list",
    description: "Enable or configure optional features by category.",
    role: "navigation",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "settings.integrations-list",
    description: "Open a provider to configure a third-party integration.",
    role: "navigation",
    routes: ["/settings"],
    capabilityId: "host.health.pages",
  },
  {
    id: "settings.model-provider",
    description:
      "Choose voice and inference models from configured providers and available local options.",
    role: "ceremony",
    routes: ["/settings"],
    capabilityId: "model_plane.choose",
  },
  {
    id: "settings.vault-key-protection",
    description:
      "Add a vault key protection method under Security, such as a recovery key, passkey, age recipient or cloud key.",
    role: "action",
    routes: ["/settings"],
    capabilityId: "vault.protectors.manage",
  },
  {
    id: "settings.second-step",
    description:
      "The authenticator app control in Security's Second step settings. It adds or removes the authenticator method.",
    role: "action",
    routes: ["/settings"],
    capabilityId: "vault.second_step.code",
  },
  {
    id: "settings.second-step.email",
    description:
      "The email code control in Security's Second step settings. It adds or removes an email fallback.",
    role: "action",
    routes: ["/settings"],
    capabilityId: "vault.second_step.code",
  },
  {
    id: "settings.recovery",
    description:
      "View unused recovery codes under Security, or create a new set.",
    role: "action",
    routes: ["/settings"],
    capabilityId: "vault.recovery_codes",
  },
  {
    id: "settings.account-factors",
    description:
      "Manage passkeys and authenticator apps for the signed-in account. These factors verify account sign-in, not vault unlock.",
    role: "action",
    routes: ["/settings"],
    capabilityId: "identity.account_factors.enroll",
  },
  {
    id: "settings.features",
    description:
      "Enable and configure optional features for this installation.",
    role: "navigation",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "settings.integrations",
    description:
      "Configure third-party services for identity, encryption, backups and other features.",
    role: "navigation",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "settings.vaults",
    description: "Open, create or remove vaults on this device.",
    role: "navigation",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "settings.danger",
    description:
      "Delete this vault from this browser or manage items in Trash.",
    role: "navigation",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "settings.auto-lock",
    description:
      "Chooses how long the vault stays unlocked while idle before its key is dropped from memory.",
    role: "action",
    routes: ["/settings"],
    capabilityId: null,
  },

  // ── Statusline detail: the health notice ──────────────────────────────
  {
    id: "notifications.health",
    description:
      "Link from the notifications sheet into the password health report. Present only while the report has findings.",
    role: "navigation",
    routes: [],
    capabilityId: null,
  },

  ...GUIDE_TARGETS_MORE,
];

let contributedTargets: readonly GuideTargetDescriptor[] | null = null;

/**
 * The live catalog: core targets plus the ones approved capabilities have
 * contributed. A live binding, so a reader that holds the array sees what
 * the accessor last computed; readers call `mergedGuideTargets()` to be sure.
 */
export let GUIDE_TARGETS: readonly GuideTargetDescriptor[] = CORE_GUIDE_TARGETS;

export function mergedGuideTargets(): readonly GuideTargetDescriptor[] {
  const contributed = contributionsSnapshot("tutorial-target");
  if (contributed === contributedTargets) return GUIDE_TARGETS;
  contributedTargets = contributed;
  if (contributed.length === 0) {
    GUIDE_TARGETS = CORE_GUIDE_TARGETS;
    return GUIDE_TARGETS;
  }
  const seen = new Set(CORE_GUIDE_TARGETS.map((target) => target.id));
  const extra: GuideTargetDescriptor[] = [];
  for (const target of contributed) {
    if (seen.has(target.id)) continue;
    seen.add(target.id);
    extra.push(target);
  }
  GUIDE_TARGETS = Object.freeze([...CORE_GUIDE_TARGETS, ...extra]);
  return GUIDE_TARGETS;
}
