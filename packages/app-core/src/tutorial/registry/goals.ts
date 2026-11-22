import { sessionGuide } from "./session-guide.js";
/**
 * Named goals, authored help, and the deterministic guides that run when no
 * model is available at all.
 *
 * The knowledge is here, in typed data, rather than only inside a prompt. That
 * is deliberate: a browser with no on-device model and no configured endpoint
 * still gets contextual help, search, and real walkthroughs — AI makes this
 * graph conversational, it is not the place the knowledge is stored.
 */

import type { GuideGoalId } from "@opensesame/guide-lang";
import type { SupportGoalDescription } from "@opensesame/support-agent";
import { contributionsSnapshot } from "../../lib/contributions.js";
import { ACCESS_HELP } from "./access-goals.js";
import { AUTHORITY_HELP } from "./authority-help.js";
import { CONNECTIONS_HELP } from "./connections-goals.js";
import { ENVIRONMENTS_GOAL } from "./environments-goal.js";
import { FEATURE_GOALS } from "./feature-goals.js";
import type { GuideGoalDescriptor, HelpTopic } from "./goal-types.js";
import { HEALTH_REVIEW_GOAL } from "./health-goal.js";
import { IDENTITY_HELP } from "./identity-goals.js";
import { INTEGRATION_GOALS } from "./integration-goals.js";
import { ITEM_REFERENCE_HELP } from "./item-reference-help.js";
import { type GuideRouteId, scopeApplies } from "./routes.js";
import { SETUP_GOALS, SETUP_HELP, SHELL_GOALS } from "./setup-goals.js";
import { SHELL_HELP } from "./shell-goals.js";
import { isKnownGuidePredicate, readGuidePredicate } from "./state.js";
import { CREATE_ITEM_GOAL, FIRST_ITEM_GOAL } from "./vault-create-goals.js";

export { CAPABILITY_TUTORIALS } from "./capability-tutorials.js";
export { FEATURE_TUTORIALS } from "./feature-goals.js";
export type { GuideGoalDescriptor, HelpTopic } from "./goal-types.js";
export { INTEGRATION_TUTORIALS } from "./integration-goals.js";

/**
 * The goals the core shell always offers. A goal that walks an optional
 * section belongs to that capability (`connections-goals.ts`,
 * `access-goals.ts`, `authority-help.ts`, `identity-goals.ts`) and arrives as
 * a `tutorial-goal` contribution while the capability is in the plan.
 */
export const CORE_GUIDE_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "vault.lock",
    title: "Lock the vault",
    routes: [],
    guide: [
      "guide/1",
      'goal "vault.lock"',
      'say "Lock the vault to remove its keys from memory. Use your unlock method to open it again."',
      'focus "shell.lock" "Select Lock before leaving your device." side=top',
      'wait target "shell.lock" event=activate timeout=30000',
      'success "Locked. The vault is sealed until you unlock it again."',
      "end",
    ].join("\n"),
  },
  {
    id: "vaults.switch",
    title: "Switch to another vault on this device",
    routes: [],
    get guide() {
      return sessionGuide([
        "guide/1",
        'goal "vaults.switch"',
        'say "This device can hold personal, project and guest vaults. Switching locks the current vault unless the other vault shares its key."',
        'focus "prompt.tomb" "Select the vault name to see the vaults on this device." side=bottom',
        'wait target "prompt.tomb" event=activate timeout=30000',
        'say "Each row shows when the vault was sealed and whether it opens without a prompt. Manage vault keys or delete a vault in Settings → Vaults."',
        "end",
      ]);
    },
  },
  {
    id: "host.health.check",
    title: "Check whether OpenSesame is healthy",
    routes: [],
    guide: [
      "guide/1",
      'goal "host.health.check"',
      'say "Password health lists weak, reused and aging passwords."',
      'navigate "/vault/health"',
      'wait route "/vault/health" timeout=15000',
      'focus "vault.health.summary" "See how many passwords were reviewed and how many are weak, reused or aging." side=bottom',
      'success "Open an item to update its password."',
      "end",
    ].join("\n"),
  },
  FIRST_ITEM_GOAL,
  CREATE_ITEM_GOAL,
  HEALTH_REVIEW_GOAL,
  ENVIRONMENTS_GOAL,
  {
    id: "settings.security.review",
    title: "Security settings",
    routes: [],
    guide: [
      "guide/1",
      'goal "settings.security.review"',
      'say "Use Security to manage the keys that open this vault and any required second steps."',
      'navigate "/settings/security"',
      'wait route "/settings/security" timeout=15000',
      'focus "settings.vault-key-protection" "Select Add to enroll a recovery key, passkey, age recipient or cloud key. You can test enrolled keys here." side=top',
      'focus "settings.second-step" "Manage your authenticator app here. Verify a code when you add it." side=top',
      'success "Select Add to choose a key type."',
      "end",
    ].join("\n"),
  },
  ...SETUP_GOALS,
  {
    id: "vault.recovery-codes",
    title: "Save the recovery codes",
    routes: [],
    requires: ["vault.recovery-made"],
    guide: [
      "guide/1",
      'goal "vault.recovery-codes"',
      'say "Each recovery code can replace your second step once. The codes are shown when you first enable a second step; save them somewhere separate from your phone."',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/settings/security"',
      'wait route "/settings/security" timeout=15000',
      'focus "settings.recovery" "Select View recovery codes to see unused codes or create a new set." side=bottom',
      "end",
    ].join("\n"),
  },
  {
    id: "vault.item-types.install",
    title: "Install a vault item type",
    routes: [],
    capabilities: [
      "vault.derived-records",
      "vault.passkey-records",
      "vault.certificate-records",
    ],
    guide: [
      "guide/1",
      'goal "vault.item-types.install"',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/settings"',
      'wait route "/settings" timeout=15000',
      'focus "nav.settings.item-types" "Item types opens the page for installing and configuring the types this vault can hold." side=right',
      'navigate "/settings/item-types"',
      'wait route "/settings/item-types" timeout=15000',
      'focus "settings.item-types" "Turn on a built-in type to install it. To add another type, review its manifest from a configured Git repository." side=top',
      "end",
    ].join("\n"),
  },
  {
    id: "vault.export",
    title: "Export the vault",
    routes: [],
    guide: [
      "guide/1",
      'goal "vault.export"',
      'say "Export an encrypted backup to move your vault to another device. Open it using your existing vault unlock method."',
      'navigate "/vault/list"',
      'wait route "/vault/list" timeout=15000',
      'focus "vault.export" "Select Export. On a phone, hold +, slide down to Export, then release. Choose where to save the file." side=bottom',
      "end",
    ].join("\n"),
  },
  {
    id: "app.install",
    title: "Install this app on the device",
    routes: ["/settings"],
    requires: ["install.offered"],
    guide: [
      "guide/1",
      'goal "app.install"',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/settings"',
      'wait route "/settings" timeout=15000',
      'focus "settings.install" "Select Install to add OpenSesame to this device." side=bottom',
      "end",
    ].join("\n"),
  },
  {
    id: "client.support",
    title: "Ask in-product support",
    routes: [],
    guide: [
      "guide/1",
      'goal "client.support"',
      'say "Use Ask for help with this screen. Open Tutorials to browse or replay walkthroughs."',
      'focus "shell.support" "Select Help to ask a question or browse tutorials." side=right',
      'wait target "shell.support" event=activate timeout=30000',
      'success "Ask a question, or choose a tutorial from the list."',
      "end",
    ].join("\n"),
  },
  ...SHELL_GOALS,
  ...FEATURE_GOALS,
  ...INTEGRATION_GOALS,
];

/** Authored help whose walkthrough is a core goal. */
export const CORE_HELP_TOPICS: readonly HelpTopic[] = [
  {
    id: "help.lock",
    title: "Where do I lock the vault?",
    answer:
      "The lock sits beside your profile and vault switcher, in the sidebar or the phone header. Locking drops the vault keys held in memory; your enrolled unlock method opens it again. Settings → Security can also lock automatically after a period of inactivity.",
    routes: [],
    goal: "vault.lock",
    keywords: [
      "lock",
      "locking",
      "logout",
      "log out",
      "sign out",
      "leave",
      "away",
      "idle",
      "auto-lock",
    ],
  },
  {
    id: "help.health",
    title: "How do I tell whether OpenSesame is healthy?",
    answer:
      "Open Password health in Vault to review weak, reused and aging passwords.",
    routes: [],
    goal: "host.health.check",
    keywords: [
      "health",
      "healthy",
      "status",
      "reachable",
      "online",
      "down",
      "connectivity",
      "plane",
      "statusline",
      "working",
    ],
  },
  {
    id: "help.vault.item.create",
    title: "How do I add an account or a secret?",
    answer:
      "Vault → New item. The kind follows whichever filter is active, so narrowing to Accounts first gives you an account. Everything you enter — the name and the folder as much as the secret — is encrypted into the vault body on this device.",
    routes: [],
    goal: "vault.item.create",
    keywords: [
      "login",
      "account",
      "secret",
      "password",
      "item",
      "entry",
      "credential",
      "new",
      "create",
      "store",
      "save",
      "api key",
      "note",
      "card",
    ],
  },
  {
    id: "help.vault.health.review",
    title: "Which of my passwords are weak or reused?",
    answer:
      "Open Password health in Vault to review weak, reused and aging passwords. The report runs on this device.",
    routes: [],
    goal: "vault.health.review",
    keywords: [
      "weak",
      "reused",
      "reuse",
      "old",
      "aging",
      "strength",
      "audit",
      "health",
      "report",
      "compromised",
      "score",
    ],
  },
  {
    id: "help.settings.security.review",
    title: "Where are the unlock settings?",
    answer:
      "Open Settings → Security to manage vault keys and second steps. You can protect a new vault with a passkey or PIN.",
    routes: [],
    goal: "settings.security.review",
    keywords: [
      "unlock",
      "master password",
      "passphrase",
      "pin",
      "passkey",
      "biometric",
      "security",
      "change password",
      "reset",
      "settings",
      "lock timer",
    ],
  },
  ...SETUP_HELP,
  ...SHELL_HELP,
  ...ITEM_REFERENCE_HELP,
];

/**
 * Authored help whose walkthrough is an optional capability's goal. A topic
 * is live exactly when its goal is: a help answer never names a screen the
 * plan does not have, and no second contribution kind is needed for it.
 */
export const OPTIONAL_HELP_TOPICS: readonly HelpTopic[] = [
  ...CONNECTIONS_HELP,
  ...ACCESS_HELP,
  ...AUTHORITY_HELP,
  ...IDENTITY_HELP,
];

let contributedGoals: readonly GuideGoalDescriptor[] | null = null;

/** The live goals: core plus contributed. A live binding; see `mergedGuideGoals`. */
export let GUIDE_GOALS: readonly GuideGoalDescriptor[] = CORE_GUIDE_GOALS;
/** The live help: core topics plus the optional ones whose goal is live. */
export let HELP_TOPICS: readonly HelpTopic[] = CORE_HELP_TOPICS;

export function mergedGuideGoals(): readonly GuideGoalDescriptor[] {
  const contributed = contributionsSnapshot("tutorial-goal");
  if (contributed === contributedGoals) return GUIDE_GOALS;
  contributedGoals = contributed;
  const seen = new Set(CORE_GUIDE_GOALS.map((goal) => goal.id));
  const extra: GuideGoalDescriptor[] = [];
  for (const goal of contributed) {
    if (seen.has(goal.id)) continue;
    seen.add(goal.id);
    extra.push(goal);
  }
  GUIDE_GOALS =
    extra.length === 0
      ? CORE_GUIDE_GOALS
      : Object.freeze([...CORE_GUIDE_GOALS, ...extra]);
  HELP_TOPICS =
    extra.length === 0
      ? CORE_HELP_TOPICS
      : Object.freeze([
          ...CORE_HELP_TOPICS,
          ...OPTIONAL_HELP_TOPICS.filter(
            (topic) => topic.goal !== null && seen.has(topic.goal),
          ),
        ]);
  return GUIDE_GOALS;
}

export function mergedHelpTopics(): readonly HelpTopic[] {
  mergedGuideGoals();
  return HELP_TOPICS;
}

/** A requirement holds only when its predicate is declared and true now. */
function guidePredicateHolds(id: string): boolean {
  return isKnownGuidePredicate(id) && readGuidePredicate(id);
}

export function describeGuideGoals(
  route: GuideRouteId,
): readonly SupportGoalDescription[] {
  return mergedGuideGoals()
    .filter((goal) => goal.libraryOnly !== true)
    .filter((goal) => (goal.requires ?? []).every(guidePredicateHolds))
    .filter((goal) => scopeApplies(goal.routes, route))
    .map((goal) => ({ id: goal.id, title: goal.title }));
}

export function guideGoalIds(): readonly GuideGoalId[] {
  return mergedGuideGoals().map((goal) => goal.id);
}

export function guideGoal(id: GuideGoalId): GuideGoalDescriptor | null {
  return mergedGuideGoals().find((goal) => goal.id === id) ?? null;
}

/** Authored topics relevant to where the person currently is. */
export function helpTopicsForRoute(route: GuideRouteId): readonly HelpTopic[] {
  return mergedHelpTopics().filter((topic) =>
    scopeApplies(topic.routes, route),
  );
}
