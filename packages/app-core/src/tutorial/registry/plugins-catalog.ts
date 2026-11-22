/**
 * Targets and walkthroughs the runtime-installed plugin capabilities
 * contribute (ADR 0150 §7): each plugin's tile inside its Settings ›
 * Features section, live only while that capability is in the plan.
 */

import type { GuideGoalDescriptor } from "./goals.js";
import type { GuideTargetDescriptor } from "./targets.js";

export const SURROGATE_TARGETS: readonly GuideTargetDescriptor[] = [
  {
    id: "settings.surrogate-credentials",
    description:
      "Pair a daemon to check the surrogate proxy, change its state and review recent events. Install the proxy separately in a terminal.",
    role: "ceremony",
    routes: ["/settings"],
    capabilityId: "plugins.surrogate_proxy.switch",
  },
];

export const SURROGATE_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "settings.surrogate-credentials",
    title: "Switch the surrogate proxy on or off",
    routes: ["/settings"],
    requires: ["plugin.surrogate-proxy.panel"],
    guide: [
      "guide/1",
      'goal "settings.surrogate-credentials"',
      'say "The surrogate proxy gives tools a substitute for a credential. Install it on the daemon host, then enable it here."',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/settings/features"',
      'wait route "/settings/features" timeout=15000',
      'scroll "feature.surrogates"',
      'focus "feature.surrogates" "Enable Surrogate credentials to add the proxy." side=bottom',
      'focus "settings.surrogate-credentials" "Pair the daemon using the code from opensesame plugins pair. This panel shows the proxy status and rejected requests." side=top',
      "end",
    ].join("\n"),
  },
];

export const AUTOFILL_TARGETS: readonly GuideTargetDescriptor[] = [
  {
    id: "settings.browser-autofill",
    description:
      "Pair a daemon to check and manage the autofill extension. Install the extension separately.",
    role: "ceremony",
    routes: ["/settings"],
    capabilityId: "plugins.browser_autofill.switch",
  },
];

export const AUTOFILL_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "settings.browser-autofill",
    title: "Switch the autofill extension on or off",
    routes: ["/settings"],
    requires: ["plugin.browser-autofill.panel"],
    guide: [
      "guide/1",
      'goal "settings.browser-autofill"',
      'say "The autofill extension fills login fields. Install it separately, then enable it here."',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/settings/features"',
      'wait route "/settings/features" timeout=15000',
      'scroll "feature.autofill"',
      'focus "feature.autofill" "Enable Browser autofill to add the extension." side=bottom',
      'focus "settings.browser-autofill" "Pair the daemon using the code from opensesame plugins pair. This panel shows the extension status." side=top',
      "end",
    ].join("\n"),
  },
];
