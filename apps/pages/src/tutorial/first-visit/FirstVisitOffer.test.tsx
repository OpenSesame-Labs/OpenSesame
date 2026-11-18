/** @vitest-environment jsdom */
import {
  forgetGuidanceAnswers,
  forgetSessionAnswers,
  guidanceSeams,
  loadGuidance,
  setGuidanceMode,
} from "@opensesame/app-core/lib/guidance.js";
import type { GuideRuntimeSnapshot } from "@opensesame/guide-runtime";
import {
  act,
  cleanup,
  fireEvent,
  render,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupportController, SupportView } from "../session.js";
import { SupportContext } from "../support-context.js";
import { stubSupportController } from "../support-controller.test-support.js";
import {
  FirstVisitOffer,
  firstVisitSeams,
  offerBody,
  tourScreens,
} from "./FirstVisitOffer.js";

// The gate reads the composition, the roads and the install state; none of
// that is what this suite is about, so every requirement holds here.
const GATE = { holds: () => true };

const originalGuidance = { ...guidanceSeams };
const originalSeams = { ...firstVisitSeams };
let stored: string | null = null;
let seat: HTMLElement;
const offered = () => within(seat).queryByRole("complementary");
const choose = (name: string) =>
  fireEvent.click(within(seat).getByRole("button", { name }));

/** The runtime's snapshot while a tour for `goal` is on its first step. */
function touring(goal: string): GuideRuntimeSnapshot {
  return {
    status: "running",
    goal,
    index: 0,
    total: 1,
    runId: 1,
    message: null,
    error: null,
    tour: {
      step: 1,
      count: 1,
      kind: "narrate",
      message: "This is the first step.",
      target: null,
      side: null,
      action: false,
      degraded: false,
      canBack: false,
    },
  };
}

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
  seat = document.createElement("div");
  seat.dataset.firstVisitOffer = "shell";
  document.body.append(seat);
  guidanceSeams.read = () => stored;
  guidanceSeams.write = (value) => {
    stored = value;
  };
  firstVisitSeams.modalOpen = () => false;
  firstVisitSeams.driven = () => false;
  firstVisitSeams.editing = () => false;
  firstVisitSeams.useGate = () => GATE;
  // Most of this suite is about the card, which is what `offer` draws.
  setGuidanceMode("offer");
  forgetSessionAnswers();
});
afterEach(() => {
  cleanup();
  seat.remove();
  Object.assign(guidanceSeams, originalGuidance);
  Object.assign(firstVisitSeams, originalSeams);
  vi.useRealTimers();
});

describe("the first-visit offer", () => {
  it("offers the screen's tour once it has stood a moment", () => {
    const { support } = controller();
    mount(support);
    expect(offered()).toBeNull();
    settle();
    expect(offered()).not.toBeNull();
    expect(offered()?.getAttribute("aria-label")).toBe(
      "Tour Settings: Danger walkthrough",
    );
    expect(offered()?.textContent).toContain("complete this task");
    expect(
      within(seat).getByRole("button", { name: "Start tutorial" }),
    ).toBeTruthy();
  });

  it("starts the tour and remembers the answer", () => {
    const { support, started } = controller();
    mount(support);
    settle();
    choose("Start tutorial");
    expect(started).toHaveLength(1);
    expect(started[0]?.origin).toBe("authored");
    expect(started[0]?.source).toContain('goal "settings.danger.review"');
    expect(loadGuidance().tours).toEqual(["settings.danger.review"]);
  });

  it("remembers a declined tour and does not offer it again", () => {
    const first = controller();
    const view = mount(first.support);
    settle();
    choose("Not now");
    expect(loadGuidance().tours).toEqual(["settings.danger.review"]);
    view.unmount();
    forgetSessionAnswers();
    mount(controller().support);
    settle();
    expect(offered()).toBeNull();
  });

  it("offers a screen's next tour on a later session, not on the next visit", () => {
    // Settings › Security has several tours of its own.
    const security = () => stubSupportController("/settings/security");
    const first = mount(security().support);
    settle();
    expect(offered()?.getAttribute("aria-label")).toBe(
      "Security settings walkthrough",
    );
    choose("Not now");
    first.unmount();
    // The same session: the screen has had its answer.
    const again = mount(security().support);
    settle();
    expect(offered()).toBeNull();
    again.unmount();
    // A later session: the next tour in line.
    forgetSessionAnswers();
    mount(security().support);
    settle();
    expect(offered()?.getAttribute("aria-label")).toBe(
      "Save the recovery codes walkthrough",
    );
  });

  it("offers again in the same session once the answers are forgotten", () => {
    const first = mount(controller().support);
    settle();
    choose("Not now");
    first.unmount();
    // Settings › Guided tours › Offer again: no reload should be needed.
    forgetGuidanceAnswers();
    mount(controller().support);
    settle();
    expect(offered()?.getAttribute("aria-label")).toBe(
      "Tour Settings: Danger walkthrough",
    );
  });

  it("takes the card back when the person moves on", () => {
    const { support, set } = controller();
    mount(support);
    settle();
    act(() => set({ route: "/settings/vaults" }));
    expect(offered()).toBeNull();
    // Nothing was answered, so the tour is still owed to that screen.
    expect(loadGuidance().tours).toEqual([]);
  });

  it("says nothing while the Support sheet is open", () => {
    const { support } = controller({ open: true });
    mount(support);
    settle();
    expect(offered()).toBeNull();
  });

  it("waits for a sheet that owns the screen, then speaks", () => {
    let sheet = true;
    firstVisitSeams.modalOpen = () => sheet;
    mount(controller().support);
    settle();
    expect(offered()).toBeNull();
    // Closing the sheet changes nothing the offer depends on; it looks again.
    sheet = false;
    act(() => {
      vi.advanceTimersByTime(firstVisitSeams.retryMs + 5);
    });
    expect(offered()?.getAttribute("aria-label")).toBe(
      "Tour Settings: Danger walkthrough",
    );
  });

  it("never starts a tour over an open editor, and speaks once it closes", () => {
    setGuidanceMode("auto");
    let editing = true;
    firstVisitSeams.editing = () => editing;
    const { support, started } = controller();
    mount(support);
    settle();
    act(() => {
      vi.advanceTimersByTime(firstVisitSeams.retryMs * 3);
    });
    // A tour navigates as it goes; that would discard the unsaved draft.
    expect(started).toHaveLength(0);
    editing = false;
    act(() => {
      vi.advanceTimersByTime(firstVisitSeams.retryMs + 5);
    });
    expect(started).toHaveLength(1);
  });

  it("stops waiting when the person moves on", () => {
    firstVisitSeams.modalOpen = () => true;
    const { support, set } = controller();
    mount(support);
    settle();
    act(() => set({ open: true }));
    firstVisitSeams.modalOpen = () => false;
    act(() => {
      vi.advanceTimersByTime(firstVisitSeams.retryMs * 3);
    });
    expect(offered()).toBeNull();
  });

  it("does nothing when guidance is off", () => {
    setGuidanceMode("off");
    const { support, started } = controller();
    mount(support);
    settle();
    expect(offered()).toBeNull();
    expect(started).toHaveLength(0);
  });

  it("starts the tour itself by default, with nothing chosen", () => {
    stored = null;
    const { support, started } = controller();
    mount(support);
    settle();
    expect(offered()).toBeNull();
    expect(started).toHaveLength(1);
    expect(started[0]?.origin).toBe("authored");
  });

  it("offers instead while a script drives the browser", () => {
    stored = null;
    firstVisitSeams.driven = () => true;
    const { support, started } = controller();
    mount(support);
    settle();
    // A tour would dim the page the script is about to press.
    expect(started).toHaveLength(0);
    expect(offered()?.getAttribute("aria-label")).toBe(
      "Tour Settings: Danger walkthrough",
    );
  });

  it("honours a chosen auto mode even in a driven browser", () => {
    setGuidanceMode("auto");
    firstVisitSeams.driven = () => true;
    const { support, started } = controller();
    mount(support);
    settle();
    expect(started).toHaveLength(1);
  });

  it("records an automatic tour as answered once it is on screen", () => {
    setGuidanceMode("auto");
    const { support, started, set, stops } = controller();
    mount(support);
    settle();
    expect(offered()).toBeNull();
    expect(started).toHaveLength(1);
    // Asked for, not yet shown: the engine is still on its way.
    expect(loadGuidance().tours).toEqual([]);
    act(() => set({ guide: touring("settings.danger.review") }));
    expect(loadGuidance().tours).toEqual(["settings.danger.review"]);
    expect(stops.count).toBe(0);
  });

  it("stops an automatic tour that arrives after the person moved on", () => {
    setGuidanceMode("auto");
    const { support, started, set, stops } = controller();
    mount(support);
    settle();
    expect(started).toHaveLength(1);
    // A cold load: the person leaves before the engine has the tour ready.
    act(() => set({ route: "/nowhere" }));
    act(() => set({ guide: touring("settings.danger.review") }));
    expect(stops.count).toBe(1);
    // It was never seen, so it is still owed to its own screen.
    expect(loadGuidance().tours).toEqual([]);
  });

  it("keeps a tour whose own first step navigates elsewhere", () => {
    // `vault.item-types.install` is offered on Settings › Item types and
    // begins by navigating to the Settings root.
    setGuidanceMode("auto");
    const stub = stubSupportController("/settings/item-types");
    mount(stub.support);
    settle();
    const [asked] = stub.started;
    expect(asked?.source).toContain('navigate "/settings"');
    const goal = /goal "([^"]+)"/.exec(asked?.source ?? "")?.[1] ?? "";
    expect(goal).toBe("vault.item-types.install");
    act(() => stub.set({ route: "/settings" }));
    act(() => stub.set({ guide: touring(goal) }));
    expect(stub.stops.count).toBe(0);
    expect(loadGuidance().tours).toEqual([goal]);
  });

  it("names the screens a tour stands on", () => {
    expect(
      tourScreens(
        "/connections/git",
        'guide/1\nnavigate "/settings/integrations"\nsay "x"\nnavigate "/vault"',
      ),
    ).toEqual(["/connections/git", "/settings/integrations", "/vault"]);
  });

  it("leaves alone a tour the person started some other way", () => {
    setGuidanceMode("auto");
    const { support, set, stops } = controller();
    mount(support);
    settle();
    act(() => set({ route: "/nowhere" }));
    act(() => set({ guide: touring("vault.lock") }));
    expect(stops.count).toBe(0);
  });

  it("counts steps in plain words", () => {
    expect(offerBody(1)).toBe("Follow 1 step to complete this task.");
    expect(offerBody(6)).toBe("Follow 6 steps to complete this task.");
  });
});
