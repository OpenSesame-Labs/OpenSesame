/**
 * The target and goal the `sharing.live` capability contributes
 * (ADR 0150 as amended): the Share key beside the vault's name in the
 * shell prompt, live only while the capability is in the plan.
 */

import type { GuideGoalDescriptor } from "./goal-types.js";
import type { GuideRouteDescriptor } from "./routes.js";
import type { GuideTargetDescriptor } from "./targets.js";

export const LIVE_TARGETS: readonly GuideTargetDescriptor[] = [
  {
    id: "shell.share",
    description:
      "Start or manage a live session. Optional network and relay settings are under Advanced.",
    role: "action",
    routes: [],
    capabilityId: "shared_sessions.live_host",
  },
];

export const LIVE_ROUTES: readonly GuideRouteDescriptor[] = [];

export const LIVE_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "settings.live.host",
    title: "Host a live session",
    routes: ["/vault"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "settings.live.host"',
      'say "A live session shares requested values one at a time. It ends when you stop sharing or close this tab."',
      'navigate "/vault"',
      'wait route "/vault" timeout=15000',
      'focus "shell.share" "Select Share beside the vault name, then select Start sharing. Advanced contains optional relay and network settings." side=right',
      'success "Send the link and code to the person joining, then approve their request and return the reply code."',
      "end",
    ].join("\n"),
  },
];
