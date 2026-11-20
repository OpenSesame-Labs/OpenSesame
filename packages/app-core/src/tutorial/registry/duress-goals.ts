/**
 * The duress code and travel mode walkthroughs (ADR 0155, ADR 0143) — kept
 * out of `goals.ts` so that file's recorded line debt does not rise
 * (ADR 0093).
 *
 * Both only point: GuideLang has no directive that sets a code, presses a
 * row or starts a trip, and these guides land on Settings → Security and
 * name the rows in prose. Nothing here may interpolate a vault name, a code
 * or any value a person authored.
 */

import type { GuideGoalDescriptor, HelpTopic } from "./goals.js";

export const DURESS_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "vaults.duress-code",
    title: "Set up a duress code",
    routes: ["/settings/security"],
    guide: [
      "guide/1",
      'goal "vaults.duress-code"',
      'say "A duress code opens a decoy instead of your vault. Only a vault owner can manage it."',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/settings/security"',
      'wait route "/settings/security" timeout=15000',
      'focus "settings.security" "In the Duress panel, select Add to create a code, Change to replace it, or Clear to remove it." side=bottom',
      "end",
    ].join("\n"),
  },
  {
    id: "vaults.travel",
    title: "Prepare a vault for travel",
    routes: ["/settings/security"],
    guide: [
      "guide/1",
      'goal "vaults.travel"',
      'say "Travel mode removes vaults you choose not to carry on this device and restores them after your trip. It appears beside Duress when you open a vault you own."',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/settings/security"',
      'wait route "/settings/security" timeout=15000',
      'focus "settings.security" "In Travel mode, select Leave for a trip to remove selected vaults from this device. Select Come home from a trip to restore them." side=bottom',
      "end",
    ].join("\n"),
  },
];

export const DURESS_HELP: readonly HelpTopic[] = [
  {
    id: "help.vaults.duress-code",
    title: "How do I set a duress code?",
    answer:
      "In Settings → Security → Duress, select Add to create a code. Entering it at unlock opens a decoy. A vault owner can also change or clear the code.",
    routes: ["/settings/security"],
    goal: "vaults.duress-code",
    keywords: [
      "duress",
      "coercion",
      "coerced",
      "decoy",
      "panic",
      "second code",
      "fake vault",
    ],
  },
  {
    id: "help.vaults.travel",
    title: "How do I protect my vaults when I travel?",
    answer:
      "In a vault you own, open Settings → Security → Travel. Select Leave for a trip to remove selected vaults from this device, or Come home from a trip to restore them.",
    routes: ["/settings/security"],
    goal: "vaults.travel",
    keywords: [
      "travel",
      "trip",
      "border",
      "customs",
      "airport",
      "leave",
      "come home",
      "return",
      "carry",
      "hide vaults",
    ],
  },
];
