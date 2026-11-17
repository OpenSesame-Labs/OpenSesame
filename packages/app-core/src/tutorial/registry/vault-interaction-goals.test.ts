/** @vitest-environment jsdom */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DROPS_GOALS } from "./drops-catalog.js";
import { CORE_GUIDE_GOALS } from "./goals.js";
import { KEYBOARD_GOALS } from "./keyboard-goals.js";
import { registerTutorialRealm } from "./optional-tutorials.test-support.js";
import {
  provideGuideDeviceForm,
  registerGuidePredicates,
} from "./predicates.js";
import { isKnownGuidePredicate } from "./state.js";
import { VAULT_ITEM_GOALS } from "./vault-item-goals.js";

const GOALS = [...VAULT_ITEM_GOALS, ...DROPS_GOALS, ...KEYBOARD_GOALS];

let revokeRealm = () => {};
beforeAll(() => {
  registerGuidePredicates();
  revokeRealm = registerTutorialRealm();
});
afterAll(() => {
  provideGuideDeviceForm(() => ({ narrow: false, keys: true }));
  revokeRealm();
});

const lines = (guide: string) => guide.split("\n");

describe("the tutorials for what a person does with an item", () => {
  it("are offered from the library, never chosen by a model for a screen", () => {
    for (const goal of GOALS) {
      expect(goal.libraryOnly, goal.id).toBe(true);
    }
  });

  it("require only predicates the registry declares", () => {
    for (const goal of GOALS) {
      for (const predicate of goal.requires ?? []) {
        expect(isKnownGuidePredicate(predicate), goal.id).toBe(true);
      }
    }
  });

  it("open the place a control is in before they point at it", () => {
    const places: readonly [prefix: string, route: string][] = [
      ["item.", "/vault/item"],
      ["trash.", "/vault/trash"],
    ];
    for (const goal of GOALS) {
      let here = "";
      for (const line of lines(goal.guide)) {
        const navigate = /^navigate "([^"]+)"/.exec(line);
        if (navigate?.[1]) here = navigate[1];
        const point = /^focus "([^"]+)"/.exec(line);
        for (const [prefix, route] of places) {
          if (point?.[1]?.startsWith(prefix)) {
            expect(here, `${goal.id} points at ${point[1]}`).toBe(route);
          }
        }
      }
    }
  });

  it("only point at a locked key: none waits for it to be pressed", () => {
    // Trash, share and delete are locked (ADR 0156). A tour that waited for
    // the person to press one would be asking for it.
    for (const id of ["vault.item.trash", "vault.item.share"]) {
      const goal = GOALS.find((candidate) => candidate.id === id);
      expect(goal, id).toBeDefined();
      expect(goal?.guide, id).not.toMatch(/^wait target /m);
    }
  });

  it("make no tutorial wait for the person to act on an item", () => {
    for (const goal of GOALS) {
      expect(goal.guide, goal.id).not.toContain("event=activate");
    }
  });

  it("chooses touch instructions by pointer, including on wide touchscreens", () => {
    const goals = [...GOALS, ...CORE_GUIDE_GOALS];
    const guide = (id: string) =>
      goals.find((goal) => goal.id === id)?.guide ?? "";
    provideGuideDeviceForm(() => ({ narrow: false, keys: true, touch: true }));
    for (const id of [
      "vault.item.create",
      "vault.item.copy",
      "vault.item.edit",
      "vault.item.favorite",
      "vault.item.trash",
      "vault.item.share",
    ]) {
      expect(guide(id), id).not.toMatch(
        /\bpress [ensrxuy] (?:on|in|with|twice)/i,
      );
    }
    provideGuideDeviceForm(() => ({ narrow: true, keys: true, touch: false }));
    expect(guide("vault.item.copy")).toContain("press y on a row");
  });
});
