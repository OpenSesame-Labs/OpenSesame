import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tutorialStartsFrom } from "./areas.js";
import {
  FIRST_VISIT_TOURS,
  firstVisitCandidates,
  firstVisitTour,
} from "./first-visit.js";
import { guideGoal, mergedGuideGoals } from "./goals.js";
import { registerTutorialRealm } from "./optional-tutorials.test-support.js";
import { mergedGuideRoutes } from "./routes.js";

let revoke = () => {};
beforeAll(() => {
  revoke = registerTutorialRealm();
});
afterAll(() => revoke());

describe("first-visit tours", () => {
  it("names only tutorials that exist", () => {
    for (const [route, goals] of Object.entries(FIRST_VISIT_TOURS)) {
      for (const id of goals) {
        expect(guideGoal(id), `${route} names ${id}`).not.toBeNull();
      }
    }
  });

  it("names only tutorials that can start from their route", () => {
    for (const [route, goals] of Object.entries(FIRST_VISIT_TOURS)) {
      for (const id of goals) {
        const goal = guideGoal(id);
        if (goal === null) continue;
        expect(
          tutorialStartsFrom(goal, route),
          `${id} cannot start from ${route}`,
        ).toBe(true);
      }
    }
  });

  it("gives every route a tour to introduce it", () => {
    // The two gate parents are scopes, not screens: nothing reports them.
    const parents = new Set(["/unlock", "/setup"]);
    for (const route of mergedGuideRoutes()) {
      if (parents.has(route.id)) continue;
      expect(
        firstVisitCandidates(route.id).length,
        `${route.id} introduces nothing`,
      ).toBeGreaterThan(0);
    }
  });

  it("inherits a parent's tours", () => {
    expect(firstVisitCandidates("/settings/features/unknown-child")).toEqual(
      FIRST_VISIT_TOURS["/settings/features"],
    );
    expect(firstVisitCandidates("/nowhere")).toEqual([]);
  });

  it("offers every tutorial from some screen", () => {
    const offered = new Set(
      mergedGuideRoutes().flatMap((route) => firstVisitCandidates(route.id)),
    );
    for (const goal of mergedGuideGoals()) {
      expect(offered.has(goal.id), `${goal.id} is offered nowhere`).toBe(true);
    }
  });

  it("offers a tutorial only where it can start", () => {
    for (const route of mergedGuideRoutes()) {
      for (const id of firstVisitCandidates(route.id)) {
        const goal = guideGoal(id);
        if (goal === null) continue;
        // An inherited list may name a tour its parent starts and it cannot;
        // `firstVisitTour` skips those, so only a route's own are held here.
        if (!(route.id in FIRST_VISIT_TOURS)) continue;
        expect(
          tutorialStartsFrom(goal, route.id),
          `${id} cannot start from ${route.id}`,
        ).toBe(true);
      }
    }
  });

  it("puts a section's own tours on its page, after the authored ones", () => {
    const features = firstVisitCandidates("/settings/features");
    expect(features[0]).toBe("settings.features.review");
    expect(features).toContain("feature.security-checks");
    expect(firstVisitCandidates("/settings/integrations")).toContain(
      "integration.password-reset",
    );
    // A section tour is not repeated on the Settings root it is scoped to.
    expect(firstVisitCandidates("/settings")).not.toContain(
      "feature.security-checks",
    );
  });

  it("offers the first candidate that is offered and unanswered", () => {
    const all = { holds: () => true };
    expect(firstVisitTour("/vault", new Set(), all)?.goal.id).toBe(
      "vault.item.first",
    );
    expect(
      firstVisitTour("/vault", new Set(["vault.item.first"]), all)?.goal.id,
    ).toBe("shell.sections");
  });

  it("skips a tour whose requirement does not hold", () => {
    const full = { holds: (predicate: string) => predicate !== "vault.empty" };
    expect(firstVisitTour("/vault", new Set(), full)?.goal.id).not.toBe(
      "vault.item.first",
    );
  });

  it("offers nothing once every candidate is answered", () => {
    const answered = new Set<string>(FIRST_VISIT_TOURS["/settings/danger"]);
    expect(firstVisitTour("/settings/danger", answered)).toBeNull();
  });

  it("counts the steps it will say", () => {
    const tour = firstVisitTour("/settings/danger", new Set());
    expect(tour?.steps).toBeGreaterThan(0);
  });
});
