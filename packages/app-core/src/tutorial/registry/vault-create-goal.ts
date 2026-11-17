import type { GuideGoalDescriptor } from "./goal-types.js";
import { isTouchGuide } from "./touch-guide.js";

export const VAULT_CREATE_GOAL: GuideGoalDescriptor = {
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
