/** @vitest-environment jsdom */
import { showToast } from "@opensesame/app-core/lib/notice-toast.js";
import {
  appendStatusNotice,
  clearNotices,
  dismissNotice,
  listNotices,
} from "@opensesame/app-core/lib/notices.js";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import fc from "fast-check";
import { useLayoutEffect, useRef, useState } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { ToastStack } from "./ToastStack.js";

function Fixture({
  active = true,
  hasSeat = true,
}: {
  active?: boolean;
  hasSeat?: boolean;
}) {
  const [seat, place] = useState<HTMLDivElement | null>(null);
  return (
    <MemoryRouter>
      <button type="button">Current task</button>
      {hasSeat ? <div data-testid="recommendation-seat" ref={place} /> : null}
      <aside aria-label="Current walkthrough">
        <button type="button">Show me</button>
        <button type="button">Not now</button>
      </aside>
      {!active ? <GateFocus /> : null}
      <ToastStack inlineSeat={seat} active={active} />
    </MemoryRouter>
  );
}

function GateFocus() {
  const field = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => field.current?.focus(), []);
  return <input ref={field} aria-label="Unlock" />;
}

function arrive(id: string, run = vi.fn()) {
  act(() =>
    appendStatusNotice({
      id,
      tone: "info",
      title: `Suggestion ${id}`,
      body: `Complete explanation ${id}`,
      act: { label: `Accept ${id}`, worded: true, run },
    }),
  );
  return run;
}

afterEach(() => {
  cleanup();
  clearNotices();
});

it("keeps the task and guide usable while an offer waits, and explains before acting", () => {
  render(<Fixture />);
  const task = screen.getByRole("button", { name: "Current task" });
  task.focus();
  const run = arrive("backups");
  expect(document.activeElement).toBe(task);
  expect(screen.getByRole("button", { name: "Show me" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Not now" })).toBeTruthy();
  expect(
    within(screen.getByTestId("recommendation-seat")).getByText(
      "Recommendation: Suggestion backups",
    ),
  ).toBeTruthy();
  expect(screen.queryByText("Complete explanation backups")).toBeNull();
  expect(screen.queryByRole("button", { name: "Accept backups" })).toBeNull();
  expect(run).not.toHaveBeenCalled();
  const review = screen.getByRole("button", {
    name: "Review Suggestion backups",
  });
  review.focus();
  fireEvent.click(review);
  const dialog = screen.getByRole("dialog", { name: "Recommendations" });
  expect(within(dialog).getByText("Complete explanation backups")).toBeTruthy();
  expect(run).not.toHaveBeenCalled();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(review);
  fireEvent.click(review);
  fireEvent.click(screen.getByRole("button", { name: "Accept backups" }));
  expect(run).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(task);
});

it("removes its preview when the tray removes its notice, and restores focus", () => {
  render(<Fixture />);
  const task = screen.getByRole("button", { name: "Current task" });
  task.focus();
  arrive("one");
  fireEvent.click(screen.getByRole("button", { name: /^Review / }));
  screen.getByRole("button", { name: "Accept one" }).focus();
  act(() => dismissNotice("one"));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByText("Recommendation: Suggestion one")).toBeNull();
  expect(document.activeElement).toBe(task);
});

it("dismisses the preview without discarding its tray notice", () => {
  render(<Fixture />);
  const task = screen.getByRole("button", { name: "Current task" });
  task.focus();
  const run = arrive("one");
  const dismiss = screen.getByRole("button", {
    name: "Dismiss recommendation: Suggestion one",
  });
  dismiss.focus();
  fireEvent.click(dismiss);
  expect(screen.queryByText("Recommendation: Suggestion one")).toBeNull();
  expect(listNotices().map((notice) => notice.id)).toContain("one");
  expect(run).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(task);
});

it("adds arrivals to an open review without moving focus or losing an offer", () => {
  render(<Fixture />);
  arrive("one");
  fireEvent.click(screen.getByRole("button", { name: /^Review / }));
  const key = screen.getByRole("button", { name: "Accept one" });
  key.focus();
  arrive("two");
  arrive("three");
  expect(document.activeElement).toBe(key);
  const dialog = screen.getByRole("dialog", { name: "Recommendations" });
  for (const id of ["one", "two", "three"]) {
    expect(within(dialog).getByText(`Complete explanation ${id}`)).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: `Accept ${id}` }),
    ).toBeTruthy();
  }
  expect(screen.getByText("3 recommendations")).toBeTruthy();
  expect(listNotices()).toHaveLength(3);
});

it("still surfaces two transient notifications alongside multiple recommendations", () => {
  render(<Fixture />);
  arrive("one");
  arrive("two");
  const send = (id: string) =>
    act(() =>
      appendStatusNotice({ id, title: id, body: "Details", tone: "info" }),
    );
  send("echo one");
  send("echo two");
  expect(screen.getByText("2 recommendations")).toBeTruthy();
  expect(screen.getByText("echo one")).toBeTruthy();
  expect(screen.getByText("echo two")).toBeTruthy();
  send("echo three");
  expect(screen.queryByText("echo one")).toBeNull();
  expect(screen.getByText("echo two")).toBeTruthy();
  expect(screen.getByText("echo three")).toBeTruthy();
  expect(listNotices()).toHaveLength(5);
});

it("dismisses one recommendation without closing the others or discarding the tray", () => {
  render(<Fixture />);
  const first = arrive("one");
  const second = arrive("two");
  fireEvent.click(
    screen.getByRole("button", { name: "Review 2 recommendations" }),
  );
  const dialog = screen.getByRole("dialog", { name: "Recommendations" });
  const dismiss = within(dialog).getByRole("button", {
    name: "Dismiss recommendation: Suggestion one",
  });
  dismiss.focus();
  fireEvent.click(dismiss);
  expect(screen.getByRole("dialog", { name: "Recommendations" })).toBe(dialog);
  expect(within(dialog).queryByText("Complete explanation one")).toBeNull();
  expect(within(dialog).getByText("Complete explanation two")).toBeTruthy();
  expect(document.activeElement).toBe(
    within(dialog).getByRole("button", { name: "Close" }),
  );
  expect(listNotices()).toHaveLength(2);
  expect(first).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Accept two" }));
  expect(second).toHaveBeenCalledTimes(1);
});

it("distinguishes matching recommendation titles and dismisses only the chosen card", () => {
  render(<Fixture />);
  const actions = [vi.fn(), vi.fn(), vi.fn()];
  act(() => {
    for (const [index, run] of actions.entries())
      appendStatusNotice({
        id: `same-${index}`,
        tone: "info",
        title: "Review security",
        body: index === 2 ? "Check recovery." : "Check passwords.",
        act: { label: `Accept ${index}`, worded: true, run },
      });
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Review 3 recommendations" }),
  );
  const dialog = screen.getByRole("dialog", { name: "Recommendations" });
  expect(
    within(dialog).getByRole("button", {
      name: "Dismiss recommendation: Review security. Check recovery.",
    }),
  ).toBeTruthy();
  fireEvent.click(
    within(dialog).getByRole("button", {
      name: "Dismiss recommendation: Review security. Check passwords. (2 of 2)",
    }),
  );
  expect(within(dialog).getByRole("button", { name: "Accept 0" })).toBeTruthy();
  expect(within(dialog).queryByRole("button", { name: "Accept 1" })).toBeNull();
  expect(within(dialog).getByRole("button", { name: "Accept 2" })).toBeTruthy();
  expect(listNotices()).toHaveLength(3);
  expect(actions.every((run) => !run.mock.calls.length)).toBe(true);
});

it("keeps focus when another card leaves, and lands it in the sheet when its own card leaves", () => {
  render(<Fixture />);
  arrive("one");
  arrive("two");
  fireEvent.click(screen.getByRole("button", { name: /^Review / }));
  const key = screen.getByRole("button", { name: "Accept one" });
  key.focus();
  act(() => dismissNotice("two"));
  expect(document.activeElement).toBe(key);
  arrive("three");
  expect(document.activeElement).toBe(key);
  act(() => dismissNotice("one"));
  const dialog = screen.getByRole("dialog", { name: "Recommendations" });
  expect(document.activeElement).toBe(
    within(dialog).getByRole("button", { name: "Close" }),
  );
  expect(within(dialog).getByText("Complete explanation three")).toBeTruthy();
});

it("waits for its in-flow seat and defers all shell arrivals during a gate", () => {
  const view = render(<Fixture hasSeat={false} />);
  arrive("one");
  expect(screen.queryByText("Recommendation: Suggestion one")).toBeNull();
  view.rerender(<Fixture />);
  expect(screen.getByText("Recommendation: Suggestion one")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /^Review / }));
  view.rerender(<Fixture active={false} />);
  expect(document.activeElement).toBe(
    screen.getByRole("textbox", { name: "Unlock" }),
  );
  act(() =>
    showToast({ id: "echo", title: "Saved", body: "Done", tone: "info" }),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByText("Recommendation: Suggestion one")).toBeNull();
  expect(screen.queryByText("Saved")).toBeNull();
  expect(listNotices().map((notice) => notice.id)).toContain("one");
  view.rerender(<Fixture />);
  expect(screen.getByText("Recommendation: Suggestion one")).toBeTruthy();
  expect(screen.getByText("Saved")).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("retains every unanswered recommendation through generated arrival sequences", () => {
  fc.assert(
    fc.property(
      fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }),
      (choices) => {
        const view = render(<Fixture />);
        const expected: string[] = [];
        choices.forEach((sticky, index) => {
          const id = `offer-${index}`;
          if (sticky) {
            expected.push(id);
            arrive(id);
          } else
            act(() => showToast({ id, title: id, body: "Done", tone: "info" }));
        });
        if (expected.length) {
          fireEvent.click(screen.getByRole("button", { name: /^Review / }));
          const dialog = screen.getByRole("dialog", {
            name: "Recommendations",
          });
          for (const id of expected) {
            expect(
              within(dialog).getByText(`Complete explanation ${id}`),
            ).toBeTruthy();
            expect(
              within(dialog).getByRole("button", { name: `Accept ${id}` }),
            ).toBeTruthy();
          }
        }
        view.unmount();
        clearNotices();
      },
    ),
    { seed: 221123, numRuns: 20 },
  );
});
