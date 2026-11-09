import { describe, expect, it } from "vitest";
import { CREATE_ITEM_GOAL, FIRST_ITEM_GOAL } from "./vault-create-goals.js";

// Grok gauntlet round 4: the first-item walkthrough used to end on Next
// at the Save control, before any secret was saved or listed. The tour
// is not done until the person has saved and the item stands in the list.
describe("the guided first item", () => {
  it("waits for the person's own save, then for the item in the list", () => {
    const guide = FIRST_ITEM_GOAL.guide;
    const saveWait = guide.indexOf(
      'wait target "item.editor.save" event=activate',
    );
    const listWait = guide.indexOf('wait target "vault.list" event=appear');
    const success = guide.indexOf("success ");
    expect(saveWait).toBeGreaterThan(-1);
    expect(listWait).toBeGreaterThan(saveWait);
    expect(success).toBeGreaterThan(listWait);
  });

  it("opens the phone list pane before pointing at New item", () => {
    for (const goal of [FIRST_ITEM_GOAL, CREATE_ITEM_GOAL]) {
      expect(goal.guide.indexOf('navigate "/vault/list"')).toBeLessThan(
        goal.guide.indexOf('focus "vault.create"'),
      );
    }
  });
});
