/** @vitest-environment jsdom */
import { showToast } from "@opensesame/app-core/lib/notice-toast.js";
import {
  appendStatusNotice,
  clearNotices,
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
import userEvent from "@testing-library/user-event";
import fc from "fast-check";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TOAST_MS, ToastStack } from "./ToastStack.js";

function Path() {
  const location = useLocation();
  return <span data-testid="path">{location.pathname}</span>;
}

function mount() {
  return render(
    <MemoryRouter>
      <button type="button">Current task</button>
      <ToastStack />
      <Path />
    </MemoryRouter>,
  );
}

function notify() {
  act(() =>
    showToast({
      id: "read",
      tone: "info",
      title: "Requests arrived",
      body: "Two requests are waiting.",
      open: { to: "/requests", label: "Review requests" },
    }),
  );
  const card = screen.getByText("Requests arrived").closest("article");
  if (!card) throw new Error("Missing notification card");
  return {
    card,
    dismiss: within(card).getByRole("button", {
      name: "Dismiss notification: Requests arrived",
    }),
    open: within(card).getByRole("button", { name: "Review requests" }),
  };
}

const advance = (amount: number) => act(() => vi.advanceTimersByTime(amount));

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  clearNotices();
  vi.useRealTimers();
});

it("remains while focused after the pointer leaves, then resumes its remaining time", () => {
  mount();
  const { card, dismiss } = notify();
  advance(TOAST_MS / 2);
  fireEvent.pointerEnter(card);
  act(() => dismiss.focus());
  fireEvent.pointerLeave(card);
  advance(TOAST_MS * 2);
  expect(screen.getByText("Requests arrived")).toBeTruthy();
  act(() => dismiss.blur());
  advance(TOAST_MS / 2 - 1);
  expect(screen.getByText("Requests arrived")).toBeTruthy();
  advance(1);
  expect(screen.queryByText("Requests arrived")).toBeNull();
});

it("remains while hovered after focus leaves, then resumes its remaining time", () => {
  mount();
  const { card, dismiss } = notify();
  advance(TOAST_MS / 2);
  act(() => dismiss.focus());
  fireEvent.pointerEnter(card);
  act(() => dismiss.blur());
  advance(TOAST_MS * 2);
  expect(screen.getByText("Requests arrived")).toBeTruthy();
  fireEvent.pointerLeave(card);
  advance(TOAST_MS / 2);
  expect(screen.queryByText("Requests arrived")).toBeNull();
});

it("keeps its clock paused when focus moves between its own controls", () => {
  mount();
  const { open, dismiss } = notify();
  act(() => open.focus());
  advance(TOAST_MS * 2);
  act(() => dismiss.focus());
  advance(TOAST_MS * 2);
  expect(screen.getByText("Requests arrived")).toBeTruthy();
  expect(document.activeElement).toBe(dismiss);
  act(() => screen.getByRole("button", { name: "Current task" }).focus());
  advance(TOAST_MS);
  expect(screen.queryByText("Requests arrived")).toBeNull();
});

it.each(["focus", "pointer"] as const)(
  "keeps the %s-held echo when a newer notice arrives",
  (channel) => {
    mount();
    const send = (id: string) =>
      act(() =>
        appendStatusNotice({ id, title: id, body: "Details", tone: "info" }),
      );
    send("first");
    const first = screen.getByText("first").closest("article");
    if (!first) throw new Error("Missing first notification");
    const dismiss = within(first).getByRole("button", {
      name: "Dismiss notification: first",
    });
    if (channel === "focus") act(() => dismiss.focus());
    else fireEvent.pointerEnter(first);
    send("second");
    send("third");
    expect(first.isConnected).toBe(true);
    if (channel === "focus") expect(document.activeElement).toBe(dismiss);
    expect(screen.queryByText("second")).toBeNull();
    expect(screen.getByText("third")).toBeTruthy();
    expect(listNotices().map((notice) => notice.id)).toEqual([
      "first",
      "second",
      "third",
    ]);
  },
);

it("keeps both echoes being read and leaves a later notice in the tray", () => {
  mount();
  const send = (id: string) =>
    act(() =>
      appendStatusNotice({ id, title: id, body: "Details", tone: "info" }),
    );
  send("first");
  send("second");
  const first = screen.getByRole("button", {
    name: "Dismiss notification: first",
  });
  const second = screen.getByText("second").closest("article");
  if (!second) throw new Error("Missing second notification");
  act(() => first.focus());
  fireEvent.pointerEnter(second);
  send("third");
  expect(document.activeElement).toBe(first);
  expect(screen.getByText("first")).toBeTruthy();
  expect(screen.getByText("second")).toBeTruthy();
  expect(screen.queryByText("third")).toBeNull();
  expect(listNotices().map((notice) => notice.id)).toEqual([
    "first",
    "second",
    "third",
  ]);
  act(() => first.blur());
  send("fourth");
  expect(screen.queryByText("first")).toBeNull();
  expect(screen.getByText("second")).toBeTruthy();
  expect(screen.getByText("fourth")).toBeTruthy();
});

it("updates an existing focused toast without changing its place in tab order", async () => {
  vi.useRealTimers();
  mount();
  const send = (id: string, title: string) =>
    act(() => showToast({ id, title, body: "Details", tone: "info" }));
  send("first", "First");
  send("second", "Second");
  const first = screen.getByRole("button", {
    name: "Dismiss notification: First",
  });
  act(() => first.focus());
  send("first", "First updated");
  expect(document.activeElement).toBe(first);
  expect(first.getAttribute("aria-label")).toBe(
    "Dismiss notification: First updated",
  );
  const user = userEvent.setup();
  await user.tab();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Dismiss notification: Second" }),
  );
});

it.each(["idle", "focus", "pointer"] as const)(
  "gives an updated toast a full reading interval when %s",
  (channel) => {
    mount();
    const send = (title: string) =>
      act(() =>
        showToast({ id: "same", title, body: "Details", tone: "info" }),
      );
    send("Before");
    advance(TOAST_MS - 100);
    const card = screen.getByText("Before").closest("article");
    if (!card) throw new Error("Missing notification");
    const dismiss = within(card).getByRole("button", {
      name: "Dismiss notification: Before",
    });
    if (channel === "focus") act(() => dismiss.focus());
    if (channel === "pointer") fireEvent.pointerEnter(card);
    send("Updated");
    advance(channel === "idle" ? 0 : TOAST_MS * 2);
    expect(screen.getByText("Updated")).toBeTruthy();
    if (channel === "focus") act(() => dismiss.blur());
    if (channel === "pointer") fireEvent.pointerLeave(card);
    advance(TOAST_MS - 1);
    expect(screen.getByText("Updated")).toBeTruthy();
    advance(1);
    expect(screen.queryByText("Updated")).toBeNull();
  },
);

it("names notifications and their actions visibly, dismissing only the selected echo", () => {
  mount();
  act(() => {
    appendStatusNotice({
      id: "one",
      tone: "info",
      title: "First arrival",
      body: "First body.",
    });
    appendStatusNotice({
      id: "two",
      tone: "info",
      title: "Second arrival",
      body: "Second body.",
    });
  });
  expect(screen.getAllByText("Notification:")).toHaveLength(2);
  const first = screen.getByRole("button", {
    name: "Dismiss notification: First arrival",
  });
  const second = screen.getByRole("button", {
    name: "Dismiss notification: Second arrival",
  });
  expect(first.textContent).toBe("Dismiss");
  expect(second.textContent).toBe("Dismiss");
  fireEvent.click(first);
  expect(screen.queryByText("First arrival")).toBeNull();
  expect(screen.getByText("Second arrival")).toBeTruthy();
  expect(listNotices().map((notice) => notice.id)).toEqual(["one", "two"]);
});

it("uses the message to distinguish notifications with the same title", () => {
  mount();
  act(() => {
    appendStatusNotice({
      id: "one",
      tone: "info",
      title: "Requests arrived",
      body: "First request is waiting.",
    });
    appendStatusNotice({
      id: "two",
      tone: "info",
      title: "Requests arrived",
      body: "Second request is waiting.",
    });
  });
  const first = screen.getByRole("button", {
    name: "Dismiss notification: Requests arrived. First request is waiting.",
  });
  const second = screen.getByRole("button", {
    name: "Dismiss notification: Requests arrived. Second request is waiting.",
  });
  fireEvent.click(second);
  expect(first.isConnected).toBe(true);
  expect(
    screen.getByRole("button", {
      name: "Dismiss notification: Requests arrived",
    }),
  ).toBe(first);
  expect(screen.queryByText("Second request is waiting.")).toBeNull();
  expect(screen.getByText("First request is waiting.")).toBeTruthy();
  expect(listNotices().map((notice) => notice.id)).toEqual(["one", "two"]);
});

it("keeps identical notifications distinct and dismisses the intended card", () => {
  mount();
  const firstDismissed = vi.fn();
  const secondDismissed = vi.fn();
  act(() =>
    showToast({
      id: "one",
      tone: "info",
      title: "Requests arrived",
      body: "A request is waiting.",
      onDismiss: firstDismissed,
    }),
  );
  const first = screen.getByRole("button", {
    name: "Dismiss notification: Requests arrived",
  });
  act(() => first.focus());
  act(() =>
    showToast({
      id: "two",
      tone: "info",
      title: "Requests arrived",
      body: "A request is waiting.",
      onDismiss: secondDismissed,
    }),
  );
  expect(document.activeElement).toBe(first);
  expect(first.getAttribute("aria-label")).toBe(
    "Dismiss notification: Requests arrived. A request is waiting. (1 of 2)",
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: "Dismiss notification: Requests arrived. A request is waiting. (2 of 2)",
    }),
  );
  expect(secondDismissed).toHaveBeenCalledOnce();
  expect(firstDismissed).not.toHaveBeenCalled();
  expect(first.isConnected).toBe(true);
  expect(document.activeElement).toBe(first);
});

it("shows the destination label and navigates only when its action is pressed", () => {
  mount();
  const { card, open } = notify();
  expect(within(card).getByText("Notification:")).toBeTruthy();
  expect(open.textContent).toBe("Review requests");
  expect(screen.getByTestId("path").textContent).toBe("/");
  fireEvent.click(open);
  expect(screen.getByTestId("path").textContent).toBe("/requests");
});

it("never expires during generated hover and focus reading sequences", () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom("enter", "leave", "focus", "blur", "advance"), {
        minLength: 1,
        maxLength: 24,
      }),
      (steps) => {
        const view = mount();
        const { card, dismiss } = notify();
        let hovered = false;
        let focused = false;
        let remaining = TOAST_MS;
        for (const step of steps) {
          if (step === "enter") {
            fireEvent.pointerEnter(card);
            hovered = true;
          } else if (step === "leave") {
            fireEvent.pointerLeave(card);
            hovered = false;
          } else if (step === "focus") {
            act(() => dismiss.focus());
            focused = true;
          } else if (step === "blur") {
            act(() => dismiss.blur());
            focused = false;
          } else {
            advance(TOAST_MS / 4);
            if (!hovered && !focused) remaining -= TOAST_MS / 4;
            if (remaining <= 0) {
              expect(screen.queryByText("Requests arrived")).toBeNull();
              break;
            }
            expect(screen.getByText("Requests arrived")).toBeTruthy();
          }
        }
        view.unmount();
        vi.clearAllTimers();
      },
    ),
    { seed: 221124, numRuns: 40 },
  );
});
