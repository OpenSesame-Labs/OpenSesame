/**
 * Targets and the walkthrough that `sharing.drops` contributes (ADR 0062,
 * ADR 0163 §6): the Share key on an open item, live only while secret
 * drops are in the plan. Sharing is a locked key (ADR 0156), so the tour
 * points at the key and says what it opens, and never presses or binds it.
 */

import type { GuideGoalDescriptor } from "./goal-types.js";
import type { GuideTargetDescriptor } from "./targets.js";
import { isTouchGuide } from "./touch-guide.js";

export const DROPS_TARGETS: readonly GuideTargetDescriptor[] = [
  {
    id: "item.share",
    description:
      "Share on an open item: opens the ways a secret can leave. Temporary drop seals the item's value into a link and a code that open one time, for a time you choose; the item is not changed. Drawn when the item has a value to share.",
    role: "ceremony",
    routes: ["/vault/item"],
    capabilityId: "vault.item.share",
  },
];

export const DROPS_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "vault.item.share",
    title: "Share an item once",
    routes: [],
    libraryOnly: true,
    requires: ["vault.has-shareable-item"],
    get guide() {
      return [
        "guide/1",
        'goal "vault.item.share"',
        'say "A temporary drop lets someone open one value once using a link and a code. It does not change the item."',
        'navigate "/vault/item"',
        'wait route "/vault/item" timeout=15000',
        isTouchGuide()
          ? 'focus "item.share" "Select Share, then Temporary drop. Choose how long the link lasts and seal the drop." side=top'
          : 'focus "item.share" "Select Share, then Temporary drop. Choose how long the link lasts and seal the drop. Press s with a row selected to open a temporary drop." side=top',
        'success "Send the link and code separately to the person receiving the drop."',
        "end",
      ].join("\n");
    },
  },
];
