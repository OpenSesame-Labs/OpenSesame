/**
 * Recommendations — the one thing worth setting up after what a person just
 * did (ADR 0221).
 *
 * A feature that would have made an act easier is invisible at the moment it
 * would have helped: somebody regenerates a password by hand and never learns
 * the vault can change it on the site for them; somebody exports a file and
 * never learns a connected forge keeps that copy current. So the act itself
 * is the cue. A screen signals what just happened (`signalRecommendation`),
 * and the first recommendation authored for that act which is still wanted
 * and has not been made before is made, once, as a notice with one key.
 *
 * This module is the registry and the policy, with no browser and no React.
 * Whether something is "wanted" is answered from facts the shell hands in —
 * a switch that is off and could be on, a backup that is not saved — so a
 * recommendation never names a feature this build does not ship or an
 * operator withheld, and never one that is already set up.
 */

import type { FeatureId } from "./capabilities/features.js";
import type { IntegrationId } from "./capabilities/integrations.js";

/** What a person just did. Arrival at a screen is not here: that is a tour. */
export const RECOMMENDATION_TRIGGERS = [
  "password.generated",
  "password.copied",
  "item.saved",
  "vault.exported",
  "vault.imported",
] as const;

export type RecommendationTrigger = (typeof RECOMMENDATION_TRIGGERS)[number];

export type RecommendationFacts = Readonly<{
  /** The feature's switch is on. */
  featureOn: (id: FeatureId) => boolean;
  /** The feature can be switched on here: shipped, and permitted. */
  featureAvailable: (id: FeatureId) => boolean;
  /** Settings › Integrations draws this section. */
  integrationDrawn: (id: IntegrationId) => boolean;
  /** A forge backup is saved on this device. */
  backupSaved: boolean;
  /** Password reset can run now; null while it is not known. */
  passwordResetReady: boolean | null;
}>;

/**
 * What the one key does. `feature` switches a feature on in place — the same
 * commit and consent receipt as its switch in Settings › Features — and then
 * leads to `next` when the feature has something left to connect. `open`
 * goes to the section where the integration is connected.
 */
export type RecommendationAction =
  | Readonly<{ kind: "feature"; feature: FeatureId; next?: string }>
  | Readonly<{ kind: "open"; to: string }>;

export type Recommendation = Readonly<{
  id: string;
  title: string;
  /** What it does and what it costs, in two sentences at most. */
  body: string;
  /** The words on the key: the object of the choice. */
  label: string;
  action: RecommendationAction;
  wanted: (facts: RecommendationFacts) => boolean;
}>;

const offAndAvailable =
  (id: FeatureId) =>
  (facts: RecommendationFacts): boolean =>
    facts.featureAvailable(id) && !facts.featureOn(id);

export const RECOMMENDATIONS: readonly Recommendation[] = [
  {
    id: "password-reset",
    title: "Let the vault change passwords for you",
    body: "Password reset signs in to the site and changes the password there whenever you generate a new one. It needs a computer-use runtime, connected next.",
    label: "Turn on password reset",
    action: {
      kind: "feature",
      feature: "password-reset",
      next: "/settings/integrations#integration-password-reset",
    },
    wanted: offAndAvailable("password-reset"),
  },
  {
    id: "password-reset-runtime",
    title: "Finish setting up password reset",
    body: "Password reset is on but has nothing to drive a browser with yet. Connect a computer-use runtime and a generated password is changed on the site too.",
    label: "Connect a runtime",
    action: {
      kind: "open",
      to: "/settings/integrations#integration-password-reset",
    },
    wanted: (facts) =>
      facts.featureOn("password-reset") &&
      facts.passwordResetReady === false &&
      facts.integrationDrawn("password-reset"),
  },
  {
    id: "breach-checks",
    title: "Check passwords against known breaches",
    body: "Breach checks flag a password that has appeared in a leak. Only the first five characters of its hash ever leave this device.",
    label: "Turn on breach checks",
    action: { kind: "feature", feature: "security-checks" },
    wanted: offAndAvailable("security-checks"),
  },
  {
    id: "backups",
    title: "Back this vault up automatically",
    body: "Everything here lives in this browser. A connected git forge keeps an encrypted copy current after every change, so a lost device is not a lost vault.",
    label: "Set up backups",
    action: { kind: "open", to: "/settings/integrations#integration-backups" },
    wanted: (facts) => !facts.backupSaved && facts.integrationDrawn("backups"),
  },
  {
    id: "autofill",
    title: "Fill passwords instead of copying them",
    body: "Browser autofill offers the matching login on the site's own sign-in form, so a password never passes through the clipboard.",
    label: "Turn on browser autofill",
    action: {
      kind: "feature",
      feature: "autofill",
      next: "/settings/features#feature-autofill",
    },
    wanted: offAndAvailable("autofill"),
  },
];

/** Which recommendations an act may bring up, most useful first. */
export const RECOMMENDATIONS_FOR = {
  "password.generated": [
    "password-reset",
    "password-reset-runtime",
    "breach-checks",
  ],
  "password.copied": ["autofill"],
  "item.saved": ["backups", "breach-checks", "autofill"],
  "vault.exported": ["backups"],
  "vault.imported": ["backups", "breach-checks"],
} satisfies Readonly<Record<RecommendationTrigger, readonly string[]>>;

export function recommendationById(id: string): Recommendation | null {
  return RECOMMENDATIONS.find((entry) => entry.id === id) ?? null;
}

/**
 * The recommendation to make after `trigger`, or null: the first one authored
 * for that act that has not been made on this device and is still wanted.
 */
export function pickRecommendation(
  trigger: RecommendationTrigger,
  facts: RecommendationFacts,
  made: ReadonlySet<string>,
): Recommendation | null {
  for (const id of RECOMMENDATIONS_FOR[trigger]) {
    if (made.has(id)) continue;
    const entry = recommendationById(id);
    if (entry?.wanted(facts)) return entry;
  }
  return null;
}

type SignalListener = (trigger: RecommendationTrigger) => void;
const signalListeners = new Set<SignalListener>();

/**
 * Say what the person just did. A signal nobody is listening for is dropped:
 * a build without the shell's recommender recommends nothing.
 */
export function signalRecommendation(trigger: RecommendationTrigger): void {
  for (const listener of [...signalListeners]) listener(trigger);
}

export function subscribeRecommendationSignals(
  listener: SignalListener,
): () => void {
  signalListeners.add(listener);
  return () => {
    signalListeners.delete(listener);
  };
}
