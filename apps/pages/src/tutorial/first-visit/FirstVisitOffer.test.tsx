/** @vitest-environment jsdom */
import {
  forgetGuidanceAnswers,
  forgetSessionAnswers,
  guidanceSeams,
  loadGuidance,
  setGuidanceMode,
} from "@opensesame/app-core/lib/guidance.js";
import {
  type ToastMessage,
  subscribeToastHides,
  subscribeToasts,
} from "@opensesame/app-core/lib/notice-toast.js";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupportController, SupportView } from "../session.js";
import { SupportContext } from "../support-context.js";
import { stubSupportController } from "../support-controller.test-support.js";
import {
  FirstVisitOffer,
  firstVisitSeams,
  offerBody,
} from "./FirstVisitOffer.js";

// The gate reads the composition, the roads and the install state; none of
// that is what this suite is about, so every requirement holds here.
const GATE = { holds: () => true };

const originalGuidance = { ...guidanceSeams };
const originalSeams = { ...firstVisitSeams };
let stored: string | null = null;
let shown: ToastMessage[] = [];
let hidden: string[] = [];
let stops: (() => void)[] = [];

const controller = (initial: Partial<SupportView> = {}) =>
  stubSupportController("/settings/danger", initial);

function mount(support: SupportController) {
  return render(
    <SupportContext.Provider value={support}>
      <FirstVisitOffer />
    </SupportContext.Provider>,
  );
}

const settle = () =>
  act(() => {
    vi.advanceTimersByTime(firstVisitSeams.delayMs + 5);
  });

beforeEach(() => {
  vi.useFakeTimers();
  stored = null;
  shown = [];
  hidden = [];
  guidanceSeams.read = () => stored;
  guidanceSeams.write = (value) => {
    stored = value;
  };
  firstVisitSeams.modalOpen = () => false;
  firstVisitSeams.useGate = () => GATE;
  forgetSessionAnswers();
  stops = [
    subscribeToasts((toast) => shown.push(toast)),
    subscribeToastHides((id) => hidden.push(id)),
  ];
});
afterEach(() => {
  cleanup();
  for (const stop of stops) stop();
  Object.assign(guidanceSeams, originalGuidance);
  Object.assign(firstVisitSeams, originalSeams);
  vi.useRealTimers();
});

describe("the first-visit offer", () => {
  it("offers the screen's tour once it has stood a moment", () => {
    const { support } = controller();
    mount(support);
    expect(shown).toHaveLength(0);
    settle();
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({
      id: "first-visit:settings.danger.review",
      title: "Tour Settings: Danger",
      sticky: true,
      choice: { label: "Show me" },
    });
    expect(shown[0]?.body).toContain("New here?");
  });

  it("starts the tour and remembers the answer", () => {
    const { support, started } = controller();
    mount(support);
    settle();
    shown[0]?.choice?.run();
    expect(started).toHaveLength(1);
    expect(started[0]?.origin).toBe("authored");
    expect(started[0]?.source).toContain('goal "settings.danger.review"');
    expect(loadGuidance().tours).toEqual(["settings.danger.review"]);
  });

  it("remembers a declined tour and does not offer it again", () => {
    const first = controller();
    const view = mount(first.support);
    settle();
    shown[0]?.onDismiss?.();
    expect(loadGuidance().tours).toEqual(["settings.danger.review"]);
    view.unmount();
    shown = [];
    forgetSessionAnswers();
    mount(controller().support);
    settle();
    expect(shown).toHaveLength(0);
  });

  it("offers a screen's next tour on a later session, not on the next visit", () => {
    // Settings › Security has several tours of its own.
    const security = () => stubSupportController("/settings/security");
    const first = mount(security().support);
    settle();
    expect(shown[0]?.id).toBe("first-visit:settings.security.review");
    shown[0]?.onDismiss?.();
    first.unmount();
    shown = [];
    // The same session: the screen has had its answer.
    const again = mount(security().support);
    settle();
    expect(shown).toHaveLength(0);
    again.unmount();
    // A later session: the next tour in line.
    forgetSessionAnswers();
    mount(security().support);
    settle();
    expect(shown[0]?.id).toBe("first-visit:vault.recovery-codes");
  });

  it("offers again in the same session once the answers are forgotten", () => {
    const first = mount(controller().support);
    settle();
    shown[0]?.onDismiss?.();
    first.unmount();
    shown = [];
    // Settings › Guided tours › Offer again: no reload should be needed.
    forgetGuidanceAnswers();
    mount(controller().support);
    settle();
    expect(shown[0]?.id).toBe("first-visit:settings.danger.review");
  });

  it("takes the card back when the person moves on", () => {
    const { support, set } = controller();
    mount(support);
    settle();
    act(() => set({ route: "/settings/vaults" }));
    expect(hidden).toContain("first-visit:settings.danger.review");
    // Nothing was answered, so the tour is still owed to that screen.
    expect(loadGuidance().tours).toEqual([]);
  });

  it("says nothing while the Support sheet is open", () => {
    const { support } = controller({ open: true });
    mount(support);
    settle();
    expect(shown).toHaveLength(0);
  });

  it("waits for a sheet that owns the screen", () => {
    firstVisitSeams.modalOpen = () => true;
    mount(controller().support);
    settle();
    expect(shown).toHaveLength(0);
  });

  it("does nothing when guidance is off", () => {
    setGuidanceMode("off");
    const { support, started } = controller();
    mount(support);
    settle();
    expect(shown).toHaveLength(0);
    expect(started).toHaveLength(0);
  });

  it("starts the tour itself in auto mode", () => {
    setGuidanceMode("auto");
    const { support, started } = controller();
    mount(support);
    settle();
    expect(shown).toHaveLength(0);
    expect(started).toHaveLength(1);
    expect(loadGuidance().tours).toEqual(["settings.danger.review"]);
  });

  it("counts steps in plain words", () => {
    expect(offerBody(1)).toContain("1 step,");
    expect(offerBody(6)).toContain("6 steps,");
  });
});
