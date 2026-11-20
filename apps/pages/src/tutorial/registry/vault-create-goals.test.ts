import { guideGoalIds } from "@opensesame/app-core/tutorial/registry/goals.js";
import { registerGuidePredicates } from "@opensesame/app-core/tutorial/registry/predicates.js";
import {
  guideRouteForLocation,
  mergedGuideRoutes,
} from "@opensesame/app-core/tutorial/registry/routes.js";
import { guidePredicateIds } from "@opensesame/app-core/tutorial/registry/state.js";
import { guideTargetIds } from "@opensesame/app-core/tutorial/registry/targets.js";
import {
  CREATE_ITEM_GOAL,
  FIRST_ITEM_GOAL,
} from "@opensesame/app-core/tutorial/registry/vault-create-goals.js";
import { guideNavigationPath } from "@opensesame/app-core/tutorial/registry/vault-routes.js";
import { AUTHORED_GUIDE_LIMITS, compileGuide } from "@opensesame/guide-lang";
import { planGuideSteps } from "@opensesame/guide-runtime";
import { beforeAll, describe, expect, it } from "vitest";

// The guide must wait for a saved item and a real copy action before it ends.
beforeAll(() => registerGuidePredicates());

describe("the guided first item", () => {
  it("waits for the saved password and a copy action before finishing", () => {
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
      subject: "target",
      target: "item.copy-generated",
      event: "appear",
    });
    const copyBeat = plan.beats.find(
      (beat) => beat.target === "item.copy-generated",
    );
    expect(copyBeat?.until).toMatchObject({
      kind: "wait",
      subject: "target",
      target: "item.copy-generated",
      event: "activate",
    });
    expect(copyBeat?.ordinal).toBeGreaterThan(saveBeat?.ordinal ?? -1);
    const close = plan.beats[plan.beats.length - 1];
    expect(close?.kind).toBe("close");
    expect(close?.ordinal).toBeGreaterThan(copyBeat?.ordinal ?? -1);
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
