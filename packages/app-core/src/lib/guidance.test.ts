import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_GUIDANCE_MODE,
  forgetGuidanceAnswers,
  guidanceSeams,
  loadGuidance,
  parseGuidance,
  rememberRecommendationMade,
  rememberTourAnswered,
  setGuidanceMode,
  subscribeGuidance,
} from "./guidance.js";

const original = { ...guidanceSeams };
let stored: string | null = null;

beforeEach(() => {
  stored = null;
  guidanceSeams.read = () => stored;
  guidanceSeams.write = (value) => {
    stored = value;
  };
});
afterEach(() => {
  Object.assign(guidanceSeams, original);
});

describe("guidance record", () => {
  it("starts empty, starting tours itself, with nothing chosen", () => {
    expect(loadGuidance()).toEqual({
      mode: DEFAULT_GUIDANCE_MODE,
      chosen: false,
      tours: [],
      recommendations: [],
    });
    expect(DEFAULT_GUIDANCE_MODE).toBe("auto");
  });

  it("keeps a mode only when somebody chose it", () => {
    // Written beside the first answer, before anyone touched the setting.
    rememberTourAnswered("vault.lock");
    expect(loadGuidance().chosen).toBe(false);
    expect(
      parseGuidance(JSON.stringify({ mode: "offer", tours: [] })).mode,
    ).toBe(DEFAULT_GUIDANCE_MODE);
    setGuidanceMode("offer");
    expect(loadGuidance()).toMatchObject({ mode: "offer", chosen: true });
    // Choosing the default is still a choice.
    setGuidanceMode("auto");
    expect(loadGuidance()).toMatchObject({ mode: "auto", chosen: true });
  });

  it("remembers an answered tour once", () => {
    rememberTourAnswered("vault.item.first");
    rememberTourAnswered("vault.item.first");
    expect(loadGuidance().tours).toEqual(["vault.item.first"]);
    expect(JSON.parse(stored ?? "{}").tours).toEqual(["vault.item.first"]);
  });

  it("remembers a recommendation that was made", () => {
    rememberRecommendationMade("backups");
    expect(loadGuidance().recommendations).toEqual(["backups"]);
  });

  it("keeps ids only", () => {
    rememberTourAnswered("how do I reset my bank password?");
    expect(loadGuidance().tours).toEqual([]);
    expect(
      parseGuidance(
        JSON.stringify({ mode: "loud", tours: ["ok.id", 4, "Not An Id"] }),
      ),
    ).toEqual({
      mode: "auto",
      chosen: false,
      tours: ["ok.id"],
      recommendations: [],
    });
  });

  it("treats a corrupt record as empty", () => {
    expect(parseGuidance("{")).toEqual(parseGuidance(null));
    expect(parseGuidance("[]")).toEqual(parseGuidance(null));
  });

  it("changes mode and tells subscribers", () => {
    const heard = vi.fn();
    const stop = subscribeGuidance(heard);
    setGuidanceMode("offer");
    setGuidanceMode("offer");
    stop();
    setGuidanceMode("off");
    expect(heard).toHaveBeenCalledTimes(1);
    expect(loadGuidance().mode).toBe("off");
  });

  it("forgets answers and keeps the mode", () => {
    setGuidanceMode("auto");
    rememberTourAnswered("vault.export");
    rememberRecommendationMade("backups");
    forgetGuidanceAnswers();
    expect(loadGuidance()).toEqual({
      mode: "auto",
      chosen: true,
      tours: [],
      recommendations: [],
    });
  });

  it("survives storage that throws", () => {
    guidanceSeams.read = () => {
      throw new Error("no storage");
    };
    guidanceSeams.write = () => {
      throw new Error("no storage");
    };
    expect(() => rememberTourAnswered("vault.lock")).not.toThrow();
    expect(loadGuidance().mode).toBe("auto");
  });
});
