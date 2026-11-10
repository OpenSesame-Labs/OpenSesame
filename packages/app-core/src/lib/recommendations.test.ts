import { describe, expect, it, vi } from "vitest";
import { FEATURES } from "./capabilities/features.js";
import { INTEGRATIONS } from "./capabilities/integrations.js";
import {
  RECOMMENDATIONS,
  RECOMMENDATIONS_FOR,
  RECOMMENDATION_TRIGGERS,
  type RecommendationFacts,
  pickRecommendation,
  recommendationById,
  signalRecommendation,
  subscribeRecommendationSignals,
} from "./recommendations.js";

/** A fresh Default install: everything available, nothing set up. */
function facts(over: Partial<RecommendationFacts> = {}): RecommendationFacts {
  return {
    featureOn: () => false,
    featureAvailable: () => true,
    integrationDrawn: () => true,
    backupSaved: false,
    passwordResetReady: null,
    ...over,
  };
}

describe("the recommendation registry", () => {
  it("names only recommendations that exist, each under some act", () => {
    const named = new Set(Object.values(RECOMMENDATIONS_FOR).flat());
    for (const id of named) {
      expect(recommendationById(id), id).not.toBeNull();
    }
    for (const entry of RECOMMENDATIONS) {
      expect(named.has(entry.id), `${entry.id} has no act`).toBe(true);
    }
  });

  it("points only at features and sections that exist", () => {
    const features = new Set<string>(FEATURES.map((feature) => feature.id));
    const anchors = new Set([
      ...FEATURES.map((feature) => `/settings/features#feature-${feature.id}`),
      ...INTEGRATIONS.map(
        (entry) => `/settings/integrations#integration-${entry.id}`,
      ),
    ]);
    for (const { id, action } of RECOMMENDATIONS) {
      if (action.kind === "feature") {
        expect(features.has(action.feature), id).toBe(true);
        if (action.next) expect(anchors.has(action.next), id).toBe(true);
      } else {
        expect(anchors.has(action.to), id).toBe(true);
      }
    }
  });

  it("keeps its words short enough for a card", () => {
    for (const entry of RECOMMENDATIONS) {
      expect(entry.title.length, entry.id).toBeLessThanOrEqual(48);
      expect(entry.body.length, entry.id).toBeLessThanOrEqual(190);
      expect(entry.label.length, entry.id).toBeLessThanOrEqual(28);
    }
  });
});

describe("what an act recommends", () => {
  it("offers password reset after a password is generated", () => {
    expect(
      pickRecommendation("password.generated", facts(), new Set())?.id,
    ).toBe("password-reset");
  });

  it("moves on to the runtime once the feature is on but not ready", () => {
    const on = facts({
      featureOn: (id) => id === "password-reset",
      passwordResetReady: false,
    });
    expect(pickRecommendation("password.generated", on, new Set())?.id).toBe(
      "password-reset-runtime",
    );
  });

  it("recommends nothing about password reset once it can run", () => {
    const ready = facts({
      featureOn: (id) => id === "password-reset" || id === "security-checks",
      passwordResetReady: true,
    });
    expect(
      pickRecommendation("password.generated", ready, new Set()),
    ).toBeNull();
  });

  it("offers backups after a save, an export and an import", () => {
    for (const act of [
      "item.saved",
      "vault.exported",
      "vault.imported",
    ] as const) {
      expect(pickRecommendation(act, facts(), new Set())?.id).toBe("backups");
    }
  });

  it("does not offer backups that are already saved", () => {
    const saved = facts({ backupSaved: true });
    expect(pickRecommendation("vault.exported", saved, new Set())).toBeNull();
    expect(pickRecommendation("item.saved", saved, new Set())?.id).toBe(
      "breach-checks",
    );
  });

  it("makes each recommendation once", () => {
    const made = new Set(["backups", "breach-checks"]);
    expect(pickRecommendation("item.saved", facts(), made)?.id).toBe(
      "autofill",
    );
    made.add("autofill");
    expect(pickRecommendation("item.saved", facts(), made)).toBeNull();
  });

  it("never names a feature this build cannot switch on", () => {
    const bare = facts({
      featureAvailable: () => false,
      integrationDrawn: () => false,
    });
    for (const act of RECOMMENDATION_TRIGGERS) {
      expect(pickRecommendation(act, bare, new Set()), act).toBeNull();
    }
  });
});

describe("signals", () => {
  it("reach a listener, and stop when it leaves", () => {
    const heard = vi.fn();
    const stop = subscribeRecommendationSignals(heard);
    signalRecommendation("item.saved");
    stop();
    signalRecommendation("item.saved");
    expect(heard).toHaveBeenCalledTimes(1);
    expect(heard).toHaveBeenCalledWith("item.saved");
  });
});
