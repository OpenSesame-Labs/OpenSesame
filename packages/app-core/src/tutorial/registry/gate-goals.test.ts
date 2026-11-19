import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mergedGuideTargets } from "./catalog.js";
import { GATE_GOALS } from "./gate-goals.js";
import { HELP_TOPICS, guideGoal } from "./goals.js";
import { registerTutorialRealm } from "./optional-tutorials.test-support.js";
import { GUIDE_OVERLAY_ROUTES, scopeApplies } from "./routes.js";
import * as state from "./state.js";

/**
 * The tutorials of the gates (ADR 0166). The registry cannot see a screen, so
 * it holds each tour to the one thing it can: a tour is offered at a route,
 * and every control it points at is declared for that route.
 */
let revoke = () => {};
beforeAll(() => {
  revoke = registerTutorialRealm();
});
afterAll(() => revoke());

const POINTING = /^(?:focus|hint|annotate|wait target) "([^"]+)"/;

function pointedAt(guide: string): string[] {
  return guide
    .split("\n")
    .flatMap((line) => POINTING.exec(line.trim())?.[1] ?? []);
}

describe("the gate tutorials", () => {
  it("are scoped to gates, and to nothing else", () => {
    for (const goal of GATE_GOALS) {
      expect(goal.routes.length, `${goal.id} has no scope`).toBeGreaterThan(0);
      for (const route of goal.routes) {
        expect(GUIDE_OVERLAY_ROUTES.has(route), `${goal.id}: ${route}`).toBe(
          true,
        );
      }
    }
  });

  it("are live in the registry under the ids they declare", () => {
    for (const goal of GATE_GOALS) {
      expect(guideGoal(goal.id), goal.id).not.toBeNull();
    }
  });

  it("never navigate: a gate has no section to move to", () => {
    for (const goal of GATE_GOALS) {
      expect(goal.guide, goal.id).not.toMatch(/^navigate /m);
    }
  });

  it("point only at controls declared for the screen they are offered on", () => {
    const targets = new Map(
      mergedGuideTargets().map((target) => [target.id, target]),
    );
    for (const goal of GATE_GOALS) {
      const pointed = pointedAt(goal.guide);
      for (const id of pointed) {
        const target = targets.get(id);
        expect(
          target,
          `${goal.id} points at ${id}, which is not declared`,
        ).toBeDefined();
        // The first-vault journey follows the person's choices across gates.
        const routes =
          goal.id === "gate.front-door"
            ? [
                "/unlock/door",
                "/setup/choose",
                "/unlock/signin",
                "/unlock/form",
                "/unlock/passkey",
              ]
            : goal.routes;
        if (goal.id === "gate.front-door") {
          expect(
            routes.some(
              (route) => target && scopeApplies(target.routes, route),
            ),
            id,
          ).toBe(true);
          continue;
        }
        for (const route of routes) {
          expect(
            target ? scopeApplies(target.routes, route) : false,
            `${goal.id} is offered at ${route}, where ${id} is not declared`,
          ).toBe(true);
        }
      }
    }
  });

  it("give an instruction in every tutorial", () => {
    for (const goal of GATE_GOALS) {
      expect(goal.guide, goal.id).toMatch(/^(say|focus|hint|annotate) "/m);
    }
  });

  it("describes the PIN already selected on the typed unlock form", () => {
    const known = vi
      .spyOn(state, "isKnownGuidePredicate")
      .mockReturnValue(true);
    const read = vi.spyOn(state, "readGuidePredicate");
    try {
      const goal = GATE_GOALS.find((item) => item.id === "gate.unlock");
      expect(goal).toBeDefined();
      read.mockReturnValue(false);
      expect(goal?.guide).toContain("Select PIN, then select Next.");
      expect(goal?.guide).toContain('focus "unlock.seal-pin-entry"');
      expect(goal?.guide).toContain('focus "unlock.seal-pin-confirm"');
      expect(goal?.guide).toContain('focus "unlock.seal-ack"');
      expect(goal?.guide).toContain('focus "unlock.seal"');
      read.mockReturnValue(true);
      expect(goal?.guide).toContain(
        "Keep the selected method for this walkthrough.",
      );
      expect(goal?.guide).toContain(
        "Enter the credential for the selected method.",
      );
    } finally {
      known.mockRestore();
      read.mockRestore();
    }
  });

  it("keeps the new-vault passkey notice and seal action in one target", () => {
    const known = vi
      .spyOn(state, "isKnownGuidePredicate")
      .mockReturnValue(true);
    const read = vi.spyOn(state, "readGuidePredicate");
    try {
      const goal = GATE_GOALS.find((item) => item.id === "gate.unlock.passkey");
      expect(goal).toBeDefined();
      read.mockReturnValue(false);
      expect(goal?.guide).toContain('focus "unlock.seal-actions"');
      expect(goal?.guide).toContain("Accept the recovery notice");
      expect(goal?.guide).toContain(
        "If it fails or is unavailable, select PIN. If PIN is already selected, select Next.",
      );
      expect(goal?.guide).toContain(
        'wait target "unlock.seal-pin-entry" event=appear',
      );
      expect(goal?.guide).toContain('focus "unlock.seal-pin-confirm"');
      expect(goal?.guide).toContain('focus "unlock.seal-ack"');
      read.mockReturnValue(true);
      expect(goal?.guide).toContain('focus "unlock.submit"');
      expect(goal?.guide).toContain("Select Unlock with passkey");
    } finally {
      known.mockRestore();
      read.mockRestore();
    }
  });
});

describe("the written help for a gate", () => {
  it("names a tutorial only where one is written for a gate it applies to", () => {
    for (const topic of HELP_TOPICS) {
      if (topic.goal === null) continue;
      const goal = guideGoal(topic.goal);
      if (!goal) continue;
      const names = goal.routes.some((route) =>
        GUIDE_OVERLAY_ROUTES.has(route),
      );
      if (!names) continue;
      expect(
        topic.routes.some((scope) =>
          goal.routes.some(
            (route) => route === scope || route.startsWith(`${scope}/`),
          ),
        ),
        `${topic.id} names ${goal.id}, written for another screen`,
      ).toBe(true);
    }
  });
});
