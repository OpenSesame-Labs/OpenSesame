/** @vitest-environment jsdom */
import {
  forgetGuidanceAnswers,
  forgetSessionAnswers,
  guidanceSeams,
  loadGuidance,
  setGuidanceMode,
} from "@opensesame/app-core/lib/guidance.js";
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import {
  TUTORIAL_PAUSE_NOTICE,
  bindTutorialResume,
  completeQueuedTutorial,
  dequeueTutorial,
  listQueuedTutorials,
  sessionTutorialsPaused,
  setSessionTutorialsPaused,
} from "@opensesame/app-core/lib/tutorial-queue.js";
import {
  ONLY_THIS_TUTORIAL,
  PAUSE_ALL_FOR_SESSION,
  RESUME_WALKTHROUGH,
} from "@opensesame/app-core/lib/tutorial-queue-present.js";
import type { GuideRuntimeSnapshot } from "@opensesame/guide-runtime";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastStack } from "../../components/ToastStack.js";
import type { SupportController } from "../session.js";
import { SupportContext } from "../support-context.js";
import { stubSupportController } from "../support-controller.test-support.js";
import { FirstVisitOffer, firstVisitSeams } from "./FirstVisitOffer.js";

const GATE = { holds: () => true };
const originalGuidance = { ...guidanceSeams };
const originalSeams = { ...firstVisitSeams };
let stored: string | null = null;
let seat: HTMLElement;

function mount(support: SupportController) {
  return render(
    <MemoryRouter>
      <SupportContext.Provider value={support}>
        <ToastStack />
        <FirstVisitOffer />
      </SupportContext.Provider>
    </MemoryRouter>,
  );
}

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
  setGuidanceMode("offer");
  forgetSessionAnswers();
  setSessionTutorialsPaused(false);
  clearNotices();
});

afterEach(() => {
  cleanup();
  seat.remove();
  for (const item of listQueuedTutorials()) dequeueTutorial(item.goalId);
  Object.assign(guidanceSeams, originalGuidance);
  Object.assign(firstVisitSeams, originalSeams);
  setSessionTutorialsPaused(false);
  clearNotices();
  vi.useRealTimers();
});

function settle() {
  act(() => {
    vi.advanceTimersByTime(firstVisitSeams.delayMs + 5);
  });
}

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

describe("declining a first-visit offer", () => {
  it("queues the tour and asks whether to pause the session", () => {
    const { support, started } = stubSupportController("/settings/danger");
    // The shell's controller binds this. The stub does not load one.
    const unbind = bindTutorialResume((goalId, guide) => {
      void support.startGuide(guide, "authored");
      completeQueuedTutorial(goalId);
      return true;
    });
    try {
      mount(support);
      settle();
      fireEvent.click(within(seat).getByRole("button", { name: "Not now" }));
      expect(listQueuedTutorials()).toEqual([
        { goalId: "settings.danger.review" },
      ]);
      expect(
        screen.getByRole("button", { name: RESUME_WALKTHROUGH }),
      ).toBeTruthy();
      expect(
        screen.getByRole("button", { name: PAUSE_ALL_FOR_SESSION }),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: ONLY_THIS_TUTORIAL }));
      expect(sessionTutorialsPaused()).toBe(false);
      expect(
        listNotices().some((notice) => notice.id === TUTORIAL_PAUSE_NOTICE),
      ).toBe(false);
      expect(started).toHaveLength(0);
      fireEvent.click(screen.getByRole("button", { name: RESUME_WALKTHROUGH }));
      expect(started).toHaveLength(1);
      expect(started[0]?.origin).toBe("authored");
      expect(listQueuedTutorials()).toEqual([]);
    } finally {
      unbind();
    }
  });

  it("pauses every tour for this session", () => {
    const first = stubSupportController("/settings/danger");
    mount(first.support);
    settle();
    fireEvent.click(within(seat).getByRole("button", { name: "Not now" }));
    fireEvent.click(
      screen.getByRole("button", { name: PAUSE_ALL_FOR_SESSION }),
    );
    expect(sessionTutorialsPaused()).toBe(true);
    expect(listQueuedTutorials().length).toBeGreaterThan(1);
    cleanup();
    setGuidanceMode("auto");
    forgetSessionAnswers();
    const again = stubSupportController("/settings/security");
    mount(again.support);
    settle();
    expect(within(seat).queryByRole("complementary")).toBeNull();
    expect(again.started).toHaveLength(0);
  });

  it("queues the same tour once when it is declined again", () => {
    const view = mount(stubSupportController("/settings/danger").support);
    settle();
    fireEvent.click(within(seat).getByRole("button", { name: "Not now" }));
    view.unmount();
    // Settings › Guided tours › Offer again: the mode is kept, the answers go.
    forgetGuidanceAnswers();
    mount(stubSupportController("/settings/danger").support);
    settle();
    fireEvent.click(within(seat).getByRole("button", { name: "Not now" }));
    expect(listQueuedTutorials()).toEqual([
      { goalId: "settings.danger.review" },
    ]);
  });

  it("pause-all does not supersede a tour this row never asked for", () => {
    const { support, stops } = stubSupportController("/settings/danger");
    mount(support);
    setSessionTutorialsPaused(true);
    expect(stops.count).toBe(0);
  });

  it("does not supersede an accepted tour when the route changes and the session pauses", () => {
    setGuidanceMode("auto");
    const { support, set, stops } = stubSupportController("/settings/danger");
    mount(support);
    settle();
    act(() => set({ guide: touring("settings.danger.review") }));
    const accepted = stops.count;
    act(() => set({ route: "/settings" }));
    act(() => {
      setSessionTutorialsPaused(true);
    });
    expect(stops.count).toBe(accepted);
  });

  it("does not stop a running tour this row did not ask for when the session pauses", () => {
    setGuidanceMode("auto");
    const { support, set, stops } = stubSupportController("/settings/danger");
    mount(support);
    settle();
    act(() => set({ guide: touring("vault.lock") }));
    const beforePause = stops.count;
    act(() => {
      setSessionTutorialsPaused(true);
    });
    expect(stops.count).toBe(beforePause);
  });

  it("pause-all still stops an automatic tour that starts after the engine loads", () => {
    setGuidanceMode("auto");
    const { support, started, set, stops } =
      stubSupportController("/settings/danger");
    mount(support);
    settle();
    expect(started).toHaveLength(1);
    expect(loadGuidance().tours).toEqual([]);
    act(() => {
      setSessionTutorialsPaused(true);
    });
    const stopsWhileLoading = stops.count;
    act(() => set({ guide: touring("settings.danger.review") }));
    expect(stops.count).toBeGreaterThan(stopsWhileLoading);
    expect(stops.reason).toBe("superseded");
    expect(loadGuidance().tours).toEqual([]);
  });

  it("clears an offer already on screen when tutorials may not speak", () => {
    const { support } = stubSupportController("/settings/danger");
    mount(support);
    settle();
    expect(within(seat).getByRole("complementary")).toBeTruthy();
    act(() => {
      setSessionTutorialsPaused(true);
    });
    expect(within(seat).queryByRole("complementary")).toBeNull();
    act(() => {
      setSessionTutorialsPaused(false);
    });
    settle();
    expect(within(seat).getByRole("complementary")).toBeTruthy();
    act(() => {
      setGuidanceMode("off");
    });
    expect(within(seat).queryByRole("complementary")).toBeNull();
  });

  it("says nothing while this session is paused or guidance is off", () => {
    setSessionTutorialsPaused(true);
    setGuidanceMode("auto");
    const paused = stubSupportController("/settings/danger");
    mount(paused.support);
    settle();
    expect(within(seat).queryByRole("complementary")).toBeNull();
    expect(paused.started).toHaveLength(0);
    cleanup();
    setSessionTutorialsPaused(false);
    setGuidanceMode("off");
    const off = stubSupportController("/settings/danger");
    mount(off.support);
    settle();
    expect(off.started).toHaveLength(0);
    expect(listQueuedTutorials()).toEqual([]);
  });
});
