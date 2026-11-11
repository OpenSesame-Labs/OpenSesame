/** @vitest-environment jsdom */
import type { FeatureId } from "@opensesame/app-core/lib/capabilities/features.js";
import {
  guidanceSeams,
  loadGuidance,
  setGuidanceMode,
} from "@opensesame/app-core/lib/guidance.js";
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { signalRecommendation } from "@opensesame/app-core/lib/recommendations.js";
import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Recommender,
  type RecommenderDevice,
  recommenderSeams,
} from "./Recommender.js";

/** The features switched on in this case; everything is shipped and permitted. */
let on: readonly FeatureId[] = [];

const device = (): RecommenderDevice => ({
  featureOn: (id) => on.includes(id),
  featureAvailable: () => true,
  integrationDrawn: (id) => id === "backups" || id === "password-reset",
  approved: [],
});

const originalGuidance = { ...guidanceSeams };
const originalSeams = { ...recommenderSeams };
let stored: string | null = null;
let path = "";

function Where() {
  const location = useLocation();
  path = `${location.pathname}${location.hash}`;
  return null;
}

function mount() {
  return render(
    <MemoryRouter initialEntries={["/vault"]}>
      <Recommender />
      <Where />
    </MemoryRouter>,
  );
}

const settle = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(recommenderSeams.delayMs + 5);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  stored = null;
  path = "";
  on = [];
  guidanceSeams.read = () => stored;
  guidanceSeams.write = (value) => {
    stored = value;
  };
  recommenderSeams.useDevice = device;
  recommenderSeams.backupSaved = () => false;
  recommenderSeams.turnOn = vi.fn(() => Promise.resolve(null));
});
afterEach(() => {
  cleanup();
  clearNotices();
  Object.assign(guidanceSeams, originalGuidance);
  Object.assign(recommenderSeams, originalSeams);
  vi.useRealTimers();
});

describe("the recommender", () => {
  it("recommends backups after an export, with one worded key", async () => {
    mount();
    signalRecommendation("vault.exported");
    expect(listNotices()).toHaveLength(0);
    await settle();
    const [notice] = listNotices();
    expect(notice).toMatchObject({
      id: "recommend.backups",
      title: "Back this vault up automatically",
      // A key that goes to a settings section closes the tray first.
      act: { label: "Set up backups", worded: true, opens: true },
      // Kept across a reload, where the act's closure is not.
      open: {
        to: "/settings/integrations#integration-backups",
        label: "Set up backups",
      },
    });
    expect(loadGuidance().recommendations).toEqual(["backups"]);
  });

  it("opens the integration's section from the key", async () => {
    mount();
    signalRecommendation("vault.exported");
    await settle();
    act(() => listNotices()[0]?.act?.run());
    expect(path).toBe("/settings/integrations#integration-backups");
    expect(listNotices()).toHaveLength(0);
  });

  it("makes a recommendation once", async () => {
    mount();
    signalRecommendation("vault.exported");
    await settle();
    clearNotices();
    signalRecommendation("vault.exported");
    await settle();
    expect(listNotices()).toHaveLength(0);
  });

  it("does not recommend a backup that is already saved", async () => {
    recommenderSeams.backupSaved = () => true;
    mount();
    signalRecommendation("vault.exported");
    await settle();
    expect(listNotices()).toHaveLength(0);
  });

  it("switches a feature on from the key and says so", async () => {
    mount();
    signalRecommendation("password.copied");
    await settle();
    expect(listNotices()[0]?.title).toBe(
      "Fill passwords instead of copying them",
    );
    await act(async () => {
      listNotices()[0]?.act?.run();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(recommenderSeams.turnOn).toHaveBeenCalledWith("autofill");
    const [after] = listNotices();
    expect(after?.title).toBe("Browser autofill is on");
    expect(after?.open?.to).toBe("/settings/features#feature-autofill");
  });

  it("lets two switches take turns, so the second sees the first", async () => {
    // Two feature recommendations in the tray: autofill, then breach checks.
    mount();
    signalRecommendation("password.copied");
    await settle();
    signalRecommendation("item.saved");
    await settle();
    expect(listNotices().map((notice) => notice.id)).toEqual([
      "recommend.autofill",
      "recommend.backups",
    ]);
    signalRecommendation("vault.imported");
    await settle();
    const autofill = listNotices().find((n) => n.id === "recommend.autofill");
    const breach = listNotices().find(
      (n) => n.id === "recommend.breach-checks",
    );
    // The first switch is still committing when the second is pressed.
    const order: string[] = [];
    let land: () => void = () => undefined;
    recommenderSeams.turnOn = vi.fn((feature) => {
      order.push(`start:${feature}`);
      if (feature !== "autofill") {
        order.push(`end:${feature}`);
        return Promise.resolve(null);
      }
      return new Promise<string | null>((resolve) => {
        land = () => {
          order.push(`end:${feature}`);
          resolve(null);
        };
      });
    });
    await act(async () => {
      autofill?.act?.run();
      breach?.act?.run();
      await Promise.resolve();
      await Promise.resolve();
    });
    // The second has not read the selection while the first is in flight.
    expect(order).toEqual(["start:autofill"]);
    await act(async () => {
      land();
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    expect(order).toEqual([
      "start:autofill",
      "end:autofill",
      "start:security-checks",
      "end:security-checks",
    ]);
  });

  it("says when a feature could not be turned on", async () => {
    recommenderSeams.turnOn = vi.fn(() => Promise.resolve("refused · policy"));
    mount();
    signalRecommendation("password.copied");
    await settle();
    await act(async () => {
      listNotices()[0]?.act?.run();
      await Promise.resolve();
      await Promise.resolve();
    });
    const [after] = listNotices();
    expect(after?.tone).toBe("warn");
    expect(after?.body).toContain("refused · policy");
  });

  it("recommends nothing for a feature that is already on", async () => {
    on = ["autofill"];
    mount();
    signalRecommendation("password.copied");
    await settle();
    expect(listNotices()).toHaveLength(0);
  });

  it("keeps a route for a feature recommendation too", async () => {
    mount();
    signalRecommendation("password.copied");
    await settle();
    expect(listNotices()[0]?.open?.to).toBe(
      "/settings/features#feature-autofill",
    );
  });

  it("names the model when password reset has a runtime and no model", async () => {
    on = ["password-reset"];
    recommenderSeams.passwordResetBlocker = () => Promise.resolve("model");
    mount();
    signalRecommendation("password.generated");
    await settle();
    const [notice] = listNotices();
    expect(notice?.id).toBe("recommend.password-reset-model");
    expect(notice?.open?.to).toBe("/settings/features#feature-ai");
  });

  it("stays silent when guidance is switched off during the readiness check", async () => {
    on = ["password-reset"];
    let ready: (blocker: "runtime") => void = () => undefined;
    recommenderSeams.passwordResetBlocker = () =>
      new Promise((resolve) => {
        ready = resolve;
      });
    mount();
    signalRecommendation("password.generated");
    await settle();
    setGuidanceMode("off");
    await act(async () => {
      ready("runtime");
      await Promise.resolve();
    });
    expect(listNotices()).toHaveLength(0);
    expect(loadGuidance().recommendations).toEqual([]);
  });

  it("is silent when guidance is off", async () => {
    setGuidanceMode("off");
    mount();
    signalRecommendation("item.saved");
    await settle();
    expect(listNotices()).toHaveLength(0);
    expect(loadGuidance().recommendations).toEqual([]);
  });
});
