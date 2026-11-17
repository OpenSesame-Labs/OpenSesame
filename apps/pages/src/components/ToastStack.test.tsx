import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  setDesktopRinging,
  showToast,
} from "@opensesame/app-core/lib/notice-toast.js";
import {
  appendStatusNotice,
  clearNotices,
  listNotices,
  pushNotice,
} from "@opensesame/app-core/lib/notices.js";
/** @vitest-environment jsdom */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { Link, MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeMediaQueryList } from "../lib/use-narrow.test-fake.js";
import { TOAST_LIMIT, TOAST_MS, ToastStack } from "./ToastStack.js";

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "styles.css"),
  "utf8",
);

function rule(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`no ${selector} rule`);
  return css.slice(start, css.indexOf("}", start));
}

type Made = { title: string; options: NotificationOptions; closed: boolean };
const made: Made[] = [];

class FakeNotification {
  static permission: NotificationPermission = "granted";
  closed = false;
  onclick: (() => void) | null = null;
  constructor(
    public title: string,
    public options: NotificationOptions,
  ) {
    made.push({ title, options, closed: false });
  }
  close() {
    this.closed = true;
  }
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
}

function renderStack() {
  return render(
    <MemoryRouter>
      <ToastStack />
    </MemoryRouter>,
  );
}

function arrive(title: string, body = "Something happened.") {
  act(() => {
    pushNotice({ kind: "status", tone: "info", title, body });
  });
}

describe("ToastStack", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    made.length = 0;
    vi.stubGlobal("Notification", FakeNotification);
    FakeNotification.permission = "granted";
    setHidden(false);
    setDesktopRinging(false);
  });

  afterEach(() => {
    cleanup();
    clearNotices();
    setDesktopRinging(false);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("is one polite live region, drawn before anything arrives", () => {
    renderStack();
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe("");
  });

  it("is a fixed overlay, not a grid row that resizes the frame", () => {
    const toasts = rule(".toasts");
    expect(toasts).toMatch(/position:\s*fixed/);
    expect(toasts).toMatch(/z-index:\s*\d+/);
    expect(toasts).toMatch(/pointer-events:\s*none/);
    expect(toasts).not.toMatch(/grid-area/);
    expect(rule(".toast")).toMatch(/pointer-events:\s*auto/);
    expect(rule(".app")).not.toContain("toasts");
  });

  it("moves clear of the phone Add button on the vault list and back for the editor", () => {
    const dismissed = vi.fn();
    const narrow = new FakeMediaQueryList("(max-width: 900px)", true);
    vi.stubGlobal("matchMedia", () => narrow);
    render(
      <MemoryRouter initialEntries={["/vault?f=all"]}>
        <Link to="/vault/new">Open editor</Link>
        <Link to="/vault?f=all">Back to list</Link>
        <ToastStack />
      </MemoryRouter>,
    );
    expect(screen.getByRole("status").className).toContain(
      "toasts--vault-list",
    );
    act(() => {
      showToast({
        id: "offer",
        tone: "info",
        title: "Set up a backup",
        body: "An offer remains available in the notice tray.",
        sticky: true,
        onDismiss: dismissed,
      });
    });
    expect(screen.getByText("Set up a backup")).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Open editor" }));
    expect(screen.getByRole("status").className).not.toContain(
      "toasts--vault-list",
    );
    expect(screen.getByRole("status").className).toContain(
      "toasts--vault-editor",
    );
    expect(screen.queryByText("Set up a backup")).toBeNull();
    expect(dismissed).not.toHaveBeenCalled();
    act(() => {
      appendStatusNotice({
        id: "recommend.backup",
        tone: "info",
        title: "Back up the vault",
        body: "A recommendation stays in the tray.",
        act: { label: "Set up", worded: true, run: vi.fn() },
      });
    });
    expect(screen.queryByText("Back up the vault")).toBeNull();
    expect(
      listNotices().some((notice) => notice.id === "recommend.backup"),
    ).toBe(true);
    act(() => {
      showToast({
        id: "save-failed",
        tone: "err",
        title: "Save failed",
        body: "The form still needs a name.",
      });
    });
    expect(screen.getByText("Save failed")).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Back to list" }));
    expect(screen.getByText("Set up a backup")).toBeTruthy();
    expect(screen.queryByText("Back up the vault")).toBeNull();
    expect(
      listNotices().some((notice) => notice.id === "recommend.backup"),
    ).toBe(true);
    expect(dismissed).not.toHaveBeenCalled();
  });

  it("retains desktop offers in the editor and responds to a width change", () => {
    const narrow = new FakeMediaQueryList("(max-width: 900px)", false);
    vi.stubGlobal("matchMedia", () => narrow);
    render(
      <MemoryRouter initialEntries={["/vault/new"]}>
        <ToastStack />
      </MemoryRouter>,
    );
    act(() => {
      showToast({
        id: "offer",
        tone: "info",
        title: "Set up a backup",
        body: "An offer.",
        sticky: true,
      });
    });
    expect(screen.getByText("Set up a backup")).toBeTruthy();
    act(() => narrow.set(true));
    expect(screen.queryByText("Set up a backup")).toBeNull();
    act(() => narrow.set(false));
    expect(screen.getByText("Set up a backup")).toBeTruthy();
  });

  it("holds in-flow recommendations while the phone editor is open", () => {
    const dismissed = vi.fn();
    const narrow = new FakeMediaQueryList("(max-width: 900px)", true);
    vi.stubGlobal("matchMedia", () => narrow);
    const seat = document.createElement("div");
    document.body.append(seat);
    try {
      render(
        <MemoryRouter initialEntries={["/vault/new"]}>
          <Link to="/vault">Back to list</Link>
          <ToastStack inlineSeat={seat} />
        </MemoryRouter>,
      );
      act(() => {
        showToast({
          id: "offer",
          tone: "info",
          title: "Set up a backup",
          body: "An offer.",
          sticky: true,
          onDismiss: dismissed,
        });
        showToast({
          id: "save-failed",
          tone: "err",
          title: "Save failed",
          body: "The form still needs a name.",
        });
      });
      expect(screen.queryByText("Recommendation: Set up a backup")).toBeNull();
      expect(screen.getByText("Save failed")).toBeTruthy();
      fireEvent.click(screen.getByRole("link", { name: "Back to list" }));
      expect(screen.getByText("Recommendation: Set up a backup")).toBeTruthy();
      expect(dismissed).not.toHaveBeenCalled();
    } finally {
      seat.remove();
    }
  });

  it("does not bring expired transient notices back after the editor closes", () => {
    const narrow = new FakeMediaQueryList("(max-width: 900px)", true);
    vi.stubGlobal("matchMedia", () => narrow);
    render(
      <MemoryRouter initialEntries={["/vault/new"]}>
        <Link to="/vault">Back to list</Link>
        <ToastStack />
      </MemoryRouter>,
    );
    act(() => {
      for (const id of ["one", "two"]) {
        showToast({ id, tone: "info", title: id, body: id, sticky: true });
      }
      showToast({
        id: "transient",
        tone: "err",
        title: "Temporary error",
        body: "Please retry.",
      });
    });
    expect(screen.getByText("Temporary error")).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Back to list" }));
    expect(screen.queryByText("Temporary error")).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: /dismiss/i })[0]);
    expect(screen.queryByText("Temporary error")).toBeNull();
  });

  it("says an arrival in front of the person, in the notice's own words", () => {
    renderStack();
    arrive("Guest session", "Sign in to claim it.");
    const toast = screen.getByRole("status");
    expect(toast.textContent).toContain("Guest session");
    expect(toast.textContent).toContain("Sign in to claim it.");
    expect(made).toHaveLength(0);
  });

  it("goes after its time unless the person is still reading it", () => {
    renderStack();
    arrive("Saved");
    act(() => vi.advanceTimersByTime(TOAST_MS - 1));
    expect(screen.getByText("Saved")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("holds while a pointer rests on it, then gives back the time it had left", () => {
    renderStack();
    arrive("Held");
    const card = screen.getByText("Held").closest("article");
    if (!card) throw new Error("no toast card");
    act(() => vi.advanceTimersByTime(TOAST_MS / 2));
    fireEvent.pointerEnter(card);
    act(() => vi.advanceTimersByTime(TOAST_MS * 3));
    expect(screen.getByText("Held")).toBeTruthy();
    fireEvent.pointerLeave(card);
    act(() => vi.advanceTimersByTime(TOAST_MS / 2 - 1));
    expect(screen.getByText("Held")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText("Held")).toBeNull();
  });

  it("dismisses on its key; the tray keeps the notice", () => {
    renderStack();
    arrive("Gone");
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss notification: Gone" }),
    );
    expect(screen.queryByText("Gone")).toBeNull();
  });

  it("shows at most the limit at once, the newest", () => {
    renderStack();
    for (let index = 1; index <= TOAST_LIMIT + 1; index += 1)
      arrive(`Notice ${index}`);
    expect(screen.queryByText("Notice 1")).toBeNull();
    expect(screen.getByText(`Notice ${TOAST_LIMIT + 1}`)).toBeTruthy();
  });

  it("shows a toast another part of the page sent through the bus", () => {
    renderStack();
    act(() => {
      showToast({
        id: "req",
        tone: "warn",
        title: "Request waiting",
        body: "A request is waiting for you.",
      });
    });
    expect(screen.getByText("Request waiting")).toBeTruthy();
  });

  it("rings the desktop once, and no toast, when away with desktop on", () => {
    setHidden(true);
    setDesktopRinging(true);
    renderStack();
    arrive("Guest session");
    expect(screen.queryByText("Guest session")).toBeNull();
    expect(made).toHaveLength(1);
    expect(made[0]?.title).toBe("Notice waiting");
    expect(made[0]?.options.tag).toMatch(/^opensesame-notice-/);
    expect(made[0]?.options.body).not.toContain("Guest");
  });

  it("neither rings nor toasts when away with desktop off", () => {
    setHidden(true);
    setDesktopRinging(false);
    renderStack();
    arrive("Quiet");
    expect(screen.queryByText("Quiet")).toBeNull();
    expect(made).toHaveLength(0);
  });

  it("does not ring the desktop when the browser has not granted it", () => {
    setHidden(true);
    setDesktopRinging(true);
    FakeNotification.permission = "denied";
    renderStack();
    arrive("Denied");
    expect(made).toHaveLength(0);
  });
});
