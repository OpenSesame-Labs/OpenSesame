import { FIRST_ITEM_GUIDE } from "./first-vault-guide.js";
import type { GuideGoalDescriptor } from "./goal-types.js";
import { isTouchGuide } from "./state.js";

/** An empty vault offers the same password journey as first-time setup. */
export const FIRST_ITEM_GOAL: GuideGoalDescriptor = {
  id: "vault.item.first",
  title: "New password",
  routes: [],
  requires: ["vault.empty"],
  capabilities: ["vault.derived-records"],
  guide: FIRST_ITEM_GUIDE,
};

export const CREATE_ITEM_GOAL: GuideGoalDescriptor = {
  id: "vault.item.create",
  title: "Add an item",
  routes: [],
  get guide() {
    return [
      "guide/1",
      'goal "vault.item.create"',
      'say "Items are encrypted on this device before they are saved."',
      'navigate "/vault/list"',
      'wait route "/vault/list" timeout=15000',
      isTouchGuide()
        ? 'focus "vault.create" "Select New item to open the editor. The current filter chooses the item type. Nothing is stored until you save." side=bottom'
        : 'focus "vault.create" "Select New item to open the editor. The current filter chooses the item type. Nothing is stored until you save. Press n in the list to open New item." side=bottom',
      'wait target "vault.create" event=activate timeout=60000',
      'success "Name the item, enter its details and select Save."',
      "end",
    ].join("\n");
  },
};
