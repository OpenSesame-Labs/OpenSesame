import {
  AUTHORED_GUIDE_LIMITS,
  compileGuide,
} from "@opensesame/guide-lang";
import { planGuideSteps } from "@opensesame/guide-runtime";
import { beforeAll, describe, expect, it } from "vitest";
import { guideGoalIds } from "./goals.js";
import { registerGuidePredicates } from "./predicates.js";
import { mergedGuideRoutes } from "./routes.js";
import { guidePredicateIds } from "./state.js";
import { guideTargetIds } from "./targets.js";
import { CREATE_ITEM_GOAL, FIRST_ITEM_GOAL } from "./vault-create-goals.js";

// Grok gauntlet rounds 4-5: the first-item walkthrough declared success
// before any secret was saved. A beat's trailing wait is its `until` in
// the compiled plan — assert at that level, not on string order: the
// Save beat is only satisfied once the vault actually holds an item
// (a rejected press, Cancel and Escape never make that true), and the
// close comes
// after a beat standing over the list the saved item appears in.
beforeAll(() => registerGuidePredicates());

describe("the guided first item", () => {
  it("cannot complete its Save step until the vault holds the item, then stands over the list", () => {
    const compiled = compileGuide(
      FIRST_ITEM_GOAL.guide,
      {
        goals: guideGoalIds(),
        targets: guideTargetIds(),
        routes: mergedGuideRoutes().map((route) => route.id),
        predicates: guidePredicateIds(),
      },
      AUTHORED_GUIDE_LIMITS,
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const plan = planGuideSteps(compiled.program);
    const saveBeat = plan.beats.find(
      (beat) => beat.target === "item.editor.save",
    );
    expect(saveBeat?.until).toMatchObject({
      kind: "wait",
      subject: "state",
      predicate: "vault.has-items",
      expected: true,
    });
    const listBeat = plan.beats.find((beat) => beat.target === "vault.list");
    expect(listBeat).toBeDefined();
    expect(listBeat?.ordinal).toBeGreaterThan(saveBeat?.ordinal ?? -1);
    expect(listBeat?.route).toBe("/vault/list");
    const close = plan.beats[plan.beats.length - 1];
    expect(close?.kind).toBe("close");
    expect(close?.ordinal).toBeGreaterThan(listBeat?.ordinal ?? -1);
  });

  it("opens the phone list pane before pointing at New item", () => {
    for (const goal of [FIRST_ITEM_GOAL, CREATE_ITEM_GOAL]) {
      expect(goal.guide.indexOf('navigate "/vault/list"')).toBeLessThan(
        goal.guide.indexOf('focus "vault.create"'),
      );
    }
  });
});
