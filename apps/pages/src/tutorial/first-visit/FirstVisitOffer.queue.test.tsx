/** @vitest-environment jsdom */
import {
  forgetGuidanceAnswers,
  forgetSessionAnswers,
  guidanceSeams,
  setGuidanceMode,
} from "@opensesame/app-core/lib/guidance.js";
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import {
  TUTORIAL_PAUSE_NOTICE,
  bindTutorialResume,
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

describe("declining a first-visit offer", () => {
  it("queues the tour and asks whether to pause the session", () => {
    const { support, started } = stubSupportController("/settings/danger");
    // The shell's controller binds this. The stub does not load one.
    const unbind = bindTutorialResume((_goalId, guide) => {
      void support.startGuide(guide, "authored");
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
