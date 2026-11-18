/** @vitest-environment jsdom */
import {
  forgetSessionAnswers,
  guidanceSeams,
  setGuidanceMode,
} from "@opensesame/app-core/lib/guidance.js";
import { subscribeToasts } from "@opensesame/app-core/lib/notice-toast.js";
import {
  act,
  cleanup,
  fireEvent,
  render,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { enterGate } from "../gate-presence.js";
import { GateHost } from "../gate-seat.js";
import { SupportContext } from "../support-context.js";
import { stubSupportController } from "../support-controller.test-support.js";
import { FirstVisitOffer, firstVisitSeams } from "./FirstVisitOffer.js";

const originalGuidance = { ...guidanceSeams };
const originalSeams = { ...firstVisitSeams };
const gate = { holds: () => true };
let stored: string | null;

function host(name: string): HTMLElement {
  const node = document.createElement("div");
  node.dataset.firstVisitOffer = name;
  document.body.append(node);
  return node;
}

function mount(route: string, gateScreen = false) {
  const controller = stubSupportController(route);
  const view = render(
    <SupportContext.Provider value={controller.support}>
      <FirstVisitOffer gateScreen={gateScreen} />
    </SupportContext.Provider>,
  );
  act(() => vi.advanceTimersByTime(firstVisitSeams.delayMs + 5));
  return { ...controller, view };
}

beforeEach(() => {
  vi.useFakeTimers();
  stored = null;
  guidanceSeams.read = () => stored;
  guidanceSeams.write = (value) => {
    stored = value;
  };
  firstVisitSeams.modalOpen = () => false;
  firstVisitSeams.driven = () => false;
  firstVisitSeams.editing = () => false;
  firstVisitSeams.useGate = () => gate;
  setGuidanceMode("offer");
  forgetSessionAnswers();
});

afterEach(() => {
  cleanup();
  for (const item of document.querySelectorAll("[data-first-visit-offer]")) {
    item.remove();
  }
  Object.assign(guidanceSeams, originalGuidance);
  Object.assign(firstVisitSeams, originalSeams);
  vi.useRealTimers();
});

it("uses the shell seat, keeps focus, and returns it after a declined offer", () => {
  const seat = host("shell");
  const previous = document.createElement("button");
  document.body.append(previous);
  previous.focus();
  const toasts = vi.fn();
  const stop = subscribeToasts(toasts);
  try {
    mount("/settings/danger");
    expect(toasts).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(previous);
    const offer = within(seat).getByRole("complementary", {
      name: "Tour Settings: Danger walkthrough",
    });
    expect(offer.textContent).toContain("Walkthrough:");
    const dismiss = within(offer).getByRole("button", { name: "Not now" });
    dismiss.focus();
    fireEvent.click(dismiss);
    expect(document.activeElement).toBe(previous);
    expect(seat.children).toHaveLength(0);
  } finally {
    stop();
    previous.remove();
  }
});

it("prefers the screen's specific seat over the shell fallback", () => {
  const shell = host("shell");
  const specific = host("");
  mount("/settings/danger");
  expect(specific.textContent).toContain("Tour Settings: Danger");
  expect(shell.children).toHaveLength(0);
});

it("uses the gate seat even while a background shell has another seat", () => {
  const shell = host("shell");
  const specific = host("");
  const gate = host("gate");
  mount("/setup/choose", true);
  expect(gate.textContent).toContain("Choose how to set this device up");
  expect(shell.children).toHaveLength(0);
  expect(specific.children).toHaveLength(0);
});

it("takes the old route's offer away when the person leaves it", () => {
  const seat = host("shell");
  const controller = mount("/settings/danger");
  expect(seat.textContent).toContain("Tour Settings: Danger");
  act(() => controller.set({ route: "/settings/vaults" }));
  expect(seat.children).toHaveLength(0);
});

it("waits for a late seat rather than putting a toast over the page", () => {
  const toasts = vi.fn();
  const stop = subscribeToasts(toasts);
  try {
    mount("/settings/danger");
    expect(toasts).not.toHaveBeenCalled();
    const seat = host("shell");
    act(() => vi.advanceTimersByTime(firstVisitSeams.retryMs + 5));
    expect(seat.textContent).toContain("Tour Settings: Danger");
  } finally {
    stop();
  }
});

it("holds a shell offer during a gate and resumes it after the gate leaves", () => {
  const shell = host("shell");
  const gate = host("gate");
  mount("/settings/danger");
  expect(shell.textContent).toContain("Tour Settings: Danger");
  let leave = () => {};
  act(() => {
    leave = enterGate();
  });
  expect(shell.children).toHaveLength(0);
  const gateView = mount("/setup/choose", true).view;
  expect(gate.textContent).toContain("Choose how to set this device up");
  expect(shell.children).toHaveLength(0);
  act(() => {
    gateView.unmount();
    leave();
  });
  act(() => vi.advanceTimersByTime(firstVisitSeams.delayMs + 5));
  expect(gate.children).toHaveLength(0);
  expect(shell.textContent).toContain("Tour Settings: Danger");
});

it("keeps the gate's input mounted while an offer replaces the background shell offer", () => {
  const shell = host("shell");
  const shellController = stubSupportController("/settings/danger");
  const gateController = stubSupportController("/setup/choose");
  const view = render(
    <SupportContext.Provider value={shellController.support}>
      <FirstVisitOffer />
    </SupportContext.Provider>,
  );
  act(() => vi.advanceTimersByTime(firstVisitSeams.delayMs + 5));
  expect(shell.textContent).toContain("Tour Settings: Danger");
  view.rerender(
    <>
      <SupportContext.Provider value={shellController.support}>
        <FirstVisitOffer />
      </SupportContext.Provider>
      <GateHost wrappers={[]}>
        <input aria-label="Gate draft" defaultValue="kept" />
        <SupportContext.Provider value={gateController.support}>
          <FirstVisitOffer gateScreen />
        </SupportContext.Provider>
      </GateHost>
    </>,
  );
  const draft = document.querySelector<HTMLInputElement>(
    '[aria-label="Gate draft"]',
  );
  expect(draft).not.toBeNull();
  expect(shell.children).toHaveLength(0);
  act(() => vi.advanceTimersByTime(firstVisitSeams.delayMs + 5));
  const seat = document.querySelector<HTMLElement>(
    '[data-first-visit-offer="gate"]',
  );
  if (!seat) throw new Error("Gate has no seat");
  expect(seat.textContent).toContain("Choose how to set this device up");
  expect(document.querySelector('[aria-label="Gate draft"]')).toBe(draft);
  expect(draft?.value).toBe("kept");
  fireEvent.click(within(seat).getByRole("button", { name: "Not now" }));
  expect(document.querySelector('[aria-label="Gate draft"]')).toBe(draft);
  expect(draft?.value).toBe("kept");
});

it("prefers the current gate's own host over a background screen and the fallback seat", () => {
  const background = host("github");
  const controller = stubSupportController("/setup/choose");
  const view = render(
    <GateHost wrappers={[]}>
      <input aria-label="Gate draft" defaultValue="kept" />
      <div data-first-visit-offer="" data-first-visit-return="setup.finish" />
      <SupportContext.Provider value={controller.support}>
        <FirstVisitOffer gateScreen />
      </SupportContext.Provider>
    </GateHost>,
  );
  act(() => vi.advanceTimersByTime(firstVisitSeams.delayMs + 5));
  const local = view.container.querySelector<HTMLElement>(
    '.gate-offer-frame__body [data-first-visit-offer=""]',
  );
  const fallback = view.container.querySelector<HTMLElement>(
    '[data-first-visit-offer="gate"]',
  );
  expect(local?.textContent).toContain("Choose how to set this device up");
  expect(background.children).toHaveLength(0);
  expect(fallback?.children).toHaveLength(0);
  expect(view.getByLabelText("Gate draft")).toHaveProperty("value", "kept");
});
