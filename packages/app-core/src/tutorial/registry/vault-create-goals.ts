import { FIRST_ITEM_GUIDE } from "./first-vault-guide.js";
import type { GuideGoalDescriptor } from "./goal-types.js";

/** An empty vault offers the same password journey as first-time setup. */
export const FIRST_ITEM_GOAL: GuideGoalDescriptor = {
  id: "vault.item.first",
  title: "Add your first password",
  routes: [],
  requires: ["vault.empty"],
  capabilities: ["vault.derived-records"],
  guide: FIRST_ITEM_GUIDE,
};

export { VAULT_CREATE_GOAL as CREATE_ITEM_GOAL } from "./vault-create-goal.js";
