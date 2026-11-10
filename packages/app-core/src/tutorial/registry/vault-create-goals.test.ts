import { AUTHORED_GUIDE_LIMITS, compileGuide } from "@opensesame/guide-lang";
import { planGuideSteps } from "@opensesame/guide-runtime";
import { beforeAll, describe, expect, it } from "vitest";
import { guideGoalIds } from "./goals.js";
import { registerGuidePredicates } from "./predicates.js";
import { guideRouteForLocation, mergedGuideRoutes } from "./routes.js";
import { guidePredicateIds } from "./state.js";
import { guideTargetIds } from "./targets.js";
import { CREATE_ITEM_GOAL, FIRST_ITEM_GOAL } from "./vault-create-goals.js";
import { guideNavigationPath } from "./vault-routes.js";

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
      const navigateAt = goal.guide.indexOf('navigate "/vault/list"');
      const createAt = goal.guide.indexOf('focus "vault.create"');
      // -1 is less than anything: a missing navigate must fail, not pass.
      expect(navigateAt).toBeGreaterThanOrEqual(0);
      expect(createAt).toBeGreaterThan(navigateAt);
    }
  });

  it("never navigates away from the editor when the person steps Back inside it", () => {
    // Back and Replay restore the route a step was planned on. The editor
    // steps are planned on the list route, so the editor has to report as
    // that route — or Back unmounts the form and the draft typed into it.
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
    const editorBeats = planGuideSteps(compiled.program).beats.filter((beat) =>
      beat.target?.startsWith("item.editor."),
    );
    expect(editorBeats.length).toBeGreaterThan(0);
    for (const editor of ["/vault/new", "/vault/new/login"]) {
      const here = { pathname: editor, search: "" };
      for (const beat of editorBeats) {
        expect(beat.route).toBe(guideRouteForLocation(editor));
        expect(beat.route && guideNavigationPath(beat.route, here)).toBeNull();
      }
    }
  });
});
