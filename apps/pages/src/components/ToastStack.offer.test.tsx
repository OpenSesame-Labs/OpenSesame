/** @vitest-environment jsdom */
import {
  type ToastMessage,
  hideToast,
  showToast,
} from "@opensesame/app-core/lib/notice-toast.js";
import {
  appendStatusNotice,
  clearNotices,
  dismissNotice,
} from "@opensesame/app-core/lib/notices.js";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOAST_MS, ToastStack, withinLimit } from "./ToastStack.js";

function renderStack() {
  return render(
    <MemoryRouter>
      <ToastStack />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  clearNotices();
  vi.useRealTimers();
});

describe("an offer toast (ADR 0221)", () => {
  it("stays until it is answered", () => {
    renderStack();
    act(() => {
      showToast({
        id: "offer",
        tone: "info",
        title: "Tour Settings: General",
        body: "New here?",
        sticky: true,
        choice: { label: "Show me", run: () => {} },
      });
    });
    act(() => {
      vi.advanceTimersByTime(TOAST_MS * 5);
    });
    expect(screen.getByText("Tour Settings: General")).toBeTruthy();
    expect(
      screen.getByText("Tour Settings: General").closest("article")?.className,
    ).toContain("toast--offer");
  });

  it("runs its worded key and leaves", () => {
    const run = vi.fn();
    const onDismiss = vi.fn();
    renderStack();
    act(() => {
      showToast({
        id: "offer",
        tone: "info",
        title: "Add your first password",
        body: "New here?",
        sticky: true,
        choice: { label: "Show me", run },
        onDismiss,
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "Show me" }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.queryByText("Add your first password")).toBeNull();
  });

  it("tells whoever showed it that it was dismissed", () => {
    const run = vi.fn();
    const onDismiss = vi.fn();
    renderStack();
    act(() => {
      showToast({
        id: "offer",
        tone: "info",
        title: "Export the vault",
        body: "New here?",
        sticky: true,
        choice: { label: "Show me", run },
        onDismiss,
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    expect(screen.queryByText("Export the vault")).toBeNull();
  });

  it("is taken back without counting as a dismissal", () => {
    const onDismiss = vi.fn();
    renderStack();
    act(() => {
      showToast({
        id: "offer",
        tone: "info",
        title: "Lock the vault",
        body: "New here?",
        sticky: true,
        onDismiss,
      });
    });
    act(() => hideToast("offer"));
    expect(screen.queryByText("Lock the vault")).toBeNull();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("an ordinary echo still leaves on the clock, with no worded key", () => {
    renderStack();
    act(() => {
      showToast({ id: "echo", tone: "info", title: "Saved", body: "Done." });
    });
    expect(screen.queryByRole("button", { name: "Show me" })).toBeNull();
    act(() => {
      vi.advanceTimersByTime(TOAST_MS + 10);
    });
    expect(screen.queryByText("Saved")).toBeNull();
  });
});

describe("the limit, with offers on screen", () => {
  const echo = (id: string): ToastMessage => ({
    id,
    tone: "info",
    title: id,
    body: "Done.",
  });
  const offer = (id: string): ToastMessage => ({ ...echo(id), sticky: true });
  const ids = (toasts: readonly ToastMessage[]) => toasts.map((t) => t.id);

  it("an echo makes room by leaving, never an unanswered offer", () => {
    expect(ids(withinLimit([offer("tour"), echo("a")], echo("b")))).toEqual([
      "tour",
      "b",
    ]);
    expect(ids(withinLimit([echo("a"), offer("tour")], echo("b")))).toEqual([
      "tour",
      "b",
    ]);
  });

  it("with the stack full of offers, a new echo is the one left to the tray", () => {
    expect(
      ids(withinLimit([offer("tour"), offer("recommend")], echo("a"))),
    ).toEqual(["tour", "recommend"]);
  });

  it("a new offer over a full stack of offers replaces the oldest", () => {
    expect(
      ids(withinLimit([offer("one"), offer("two")], offer("three"))),
    ).toEqual(["two", "three"]);
  });

  it("keeps an offer on screen while echoes come and go", () => {
    renderStack();
    act(() => {
      showToast({ ...offer("tour"), title: "Tour Settings: General" });
      showToast(echo("first"));
      showToast(echo("second"));
    });
    expect(screen.getByText("Tour Settings: General")).toBeTruthy();
    expect(screen.queryByText("first")).toBeNull();
    expect(screen.getByText("second")).toBeTruthy();
  });
});

describe("a recommendation's echo", () => {
  it("draws the notice's worded act as its key", () => {
    const run = vi.fn();
    renderStack();
    act(() => {
      appendStatusNotice({
        id: "recommend.backups",
        tone: "info",
        title: "Back this vault up automatically",
        body: "Everything here lives in this browser.",
        open: {
          to: "/settings/integrations#integration-backups",
          label: "Set up backups",
        },
        act: { label: "Set up backups", worded: true, run },
      });
    });
    // It is a one-time prompt: it does not leave on the clock.
    act(() => {
      vi.advanceTimersByTime(TOAST_MS * 5);
    });
    // One key, not two: the route kept for a reload is the same answer.
    expect(
      screen.getAllByRole("button", { name: "Set up backups" }),
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Set up backups" }));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("leaves with its notice, answered or dismissed from the tray", () => {
    renderStack();
    act(() => {
      appendStatusNotice({
        id: "recommend.backups",
        tone: "info",
        title: "Back this vault up automatically",
        body: "Everything here lives in this browser.",
        act: { label: "Set up backups", worded: true, run: () => {} },
      });
    });
    expect(screen.getByText("Back this vault up automatically")).toBeTruthy();
    act(() => dismissNotice("recommend.backups"));
    expect(screen.queryByText("Back this vault up automatically")).toBeNull();
  });

  it("leaves an act that is not worded to the tray", () => {
    renderStack();
    act(() => {
      appendStatusNotice({
        id: "status.other",
        tone: "info",
        title: "Password reset",
        body: "Turn it on.",
        act: { label: "Settings", run: () => {} },
      });
    });
    expect(screen.getByText("Password reset")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
  });
});
