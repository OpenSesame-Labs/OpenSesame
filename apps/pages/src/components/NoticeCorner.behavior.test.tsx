/** @vitest-environment jsdom */
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
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import fc from "fast-check";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { Notices } from "./Notices.js";

function Path() {
  const location = useLocation();
  return <span data-testid="path">{location.pathname}</span>;
}

function mount() {
  return render(
    <MemoryRouter>
      <Notices shellless>
        <main>
          <input aria-label="Current task" defaultValue="draft" />
          <Path />
        </main>
      </Notices>
    </MemoryRouter>,
  );
}

function arrive(
  id: string,
  body: string,
  tone: "err" | "warn" | "info" = "err",
) {
  act(() => appendStatusNotice({ id, tone, title: "Drop", body }));
}

function expectLatestVisible(
  expected: Map<string, { body: string; kind: string }>,
) {
  const latestError = [...expected.values()]
    .filter((item) => item.kind === "error")
    .at(-1);
  const latestClaim = [...expected.values()]
    .filter((item) => item.kind === "claim")
    .at(-1);
  for (const item of [latestError, latestClaim])
    if (item) expect(screen.getByText(item.body)).toBeTruthy();
}

afterEach(() => {
  cleanup();
  clearNotices();
  vi.useRealTimers();
});

it("has named empty live regions before arrivals and presents an error once in flow", () => {
  const { container } = mount();
  expect(
    screen.getByRole("alert", { name: "Urgent notifications" }).textContent,
  ).toBe("");
  expect(
    screen.getByRole("status", { name: "Notifications" }).textContent,
  ).toBe("");
  expect(
    screen.getByRole("status", { name: "Temporary notifications" }).textContent,
  ).toBe("");
  expect(
    container.querySelector(".notice-corner")?.hasAttribute("data-active"),
  ).toBe(false);
  const task = screen.getByRole("textbox", { name: "Current task" });
  act(() => task.focus());
  arrive("identity.claim.first", "The first link is incomplete.");
  const alert = screen.getByRole("alert", { name: "Urgent notifications" });
  expect(alert.textContent).toContain("The first link is incomplete.");
  expect(screen.getByText("Notification: Drop")).toBeTruthy();
  expect(container.querySelector(".toasts .toast")).toBeNull();
  expect(document.activeElement).toBe(task);
  expect(task).toHaveProperty("value", "draft");
});

it("keeps a focused earlier error intact when a newer one arrives and retains both in the tray", () => {
  const { container } = mount();
  arrive("identity.claim.first", "First link failed.");
  const first = screen.getByRole("button", {
    name: "Dismiss notification: Drop. First link failed.",
  });
  act(() => first.focus());
  arrive("identity.claim.second", "Second link failed.");
  const second = screen.getByRole("button", {
    name: "Dismiss notification: Drop. Second link failed.",
  });
  expect(document.activeElement).toBe(first);
  expect(first.isConnected).toBe(true);
  expect(listNotices().map((notice) => notice.id)).toEqual([
    "identity.claim.first",
    "identity.claim.second",
  ]);
  expect(container.querySelector(".toasts .toast")).toBeNull();
  fireEvent.click(second);
  expect(listNotices().map((notice) => notice.id)).toEqual([
    "identity.claim.first",
  ]);
  expect(screen.getByText("First link failed.")).toBeTruthy();
});

it("tabs through newer cards in arrival order after the held card leaves", async () => {
  mount();
  arrive("first", "First link failed.");
  const first = screen.getByRole("button", {
    name: "Dismiss notification: Drop. First link failed.",
  });
  act(() => first.focus());
  arrive("second", "Second link failed.");
  arrive("identity.claim.third", "A claim needs attention.", "warn");

  await userEvent.tab();
  expect(document.activeElement).toBe(
    screen.getByRole("button", {
      name: "Dismiss notification: Drop. Second link failed.",
    }),
  );
  expect(first.isConnected).toBe(false);
  await userEvent.tab();
  expect(document.activeElement).toBe(
    screen.getByRole("button", {
      name: "Dismiss notification: Drop. A claim needs attention.",
    }),
  );
  await userEvent.tab();
  expect(document.activeElement?.getAttribute("aria-label")).toMatch(
    /^Notifications/,
  );
});

it("distinguishes identical titles and messages with stable per-notice dismiss names", () => {
  mount();
  arrive("identity.claim.first", "The same failure.");
  const first = screen.getByRole("button", {
    name: "Dismiss notification: Drop. The same failure.",
  });
  act(() => first.focus());
  arrive("identity.claim.second", "The same failure.");
  expect(first.getAttribute("aria-label")).toBe(
    "Dismiss notification: Drop. The same failure. (1 of 2)",
  );
  expect(
    screen.getByRole("button", {
      name: "Dismiss notification: Drop. The same failure. (2 of 2)",
    }),
  ).toBeTruthy();
  expect(document.activeElement).toBe(first);
});

it("updates the named live region when a second identical notice arrives", async () => {
  mount();
  arrive("identity.claim.first", "The same failure.");
  const region = screen.getByRole("alert", { name: "Urgent notifications" });
  const mutations: MutationRecord[] = [];
  const observer = new MutationObserver((records) =>
    mutations.push(...records),
  );
  observer.observe(region, {
    childList: true,
    characterData: true,
    subtree: true,
  });
  arrive("identity.claim.second", "The same failure.");
  await act(async () => {
    await Promise.resolve();
  });
  observer.disconnect();
  expect(mutations.length).toBeGreaterThan(0);
  expect(region.textContent).toBe("Notification: Drop. The same failure.");
  expect(region.children).toHaveLength(0);
});

it("announces the newest arrival, even when a claim card is rendered after it", () => {
  mount();
  arrive("first", "First error.");
  act(() =>
    screen
      .getByRole("button", { name: /Dismiss notification: Drop\. First error/ })
      .focus(),
  );
  arrive("identity.claim.middle", "Earlier claim error.");
  arrive("last", "Most recent error.");
  const region = screen.getByRole("alert", { name: "Urgent notifications" });
  expect(region.textContent).toBe("Notification: Drop. Most recent error.");
  expect(screen.getByText("Earlier claim error.")).toBeTruthy();
});

it("keeps a non-error claim and the newest error visible after an unrelated arrival", () => {
  mount();
  arrive("identity.claim.warning", "A claim needs attention.", "warn");
  arrive("other.error", "An unrelated error.");
  arrive("other.info", "An unrelated update.", "info");
  expect(
    screen.getByRole("status", { name: "Notifications" }).textContent,
  ).toContain("A claim needs attention.");
  expect(
    screen.getByRole("alert", { name: "Urgent notifications" }).textContent,
  ).toContain("An unrelated error.");
  expect(listNotices()).toHaveLength(3);
});

it("does not reuse a stale focus hold when an externally removed ID returns", () => {
  mount();
  arrive("same", "Original error.");
  const old = screen.getByRole("button", {
    name: "Dismiss notification: Drop. Original error.",
  });
  act(() => old.focus());
  act(() => {
    dismissNotice("same");
    appendStatusNotice({
      id: "same",
      tone: "err",
      title: "Drop",
      body: "Replacement error.",
    });
  });
  expect(old.isConnected).toBe(false);
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Notifications — 1 pending" }),
  );
  arrive("newer", "Newer error.");
  expect(screen.queryByText("Replacement error.")).toBeNull();
  expect(screen.getByText("Newer error.")).toBeTruthy();
  expect(listNotices().map((notice) => notice.id)).toEqual(["same", "newer"]);
});

it("keeps the full direct action and its notice in flow", () => {
  mount();
  act(() =>
    appendStatusNotice({
      id: "repair",
      tone: "err",
      title: "Connection",
      body: "Reconnect to continue.",
      open: { to: "/repair", label: "Open connection settings" },
    }),
  );
  expect(screen.getByText("Reconnect to continue.")).toBeTruthy();
  const action = screen.getByRole("button", {
    name: "Open connection settings",
  });
  expect(action.textContent).toContain("Open connection settings");
  fireEvent.click(action);
  expect(screen.getByTestId("path").textContent).toBe("/repair");
  expect(listNotices().map((notice) => notice.id)).toContain("repair");
});

it("preserves focused cards and tray history over generated arrival and dismissal sequences", () => {
  vi.useFakeTimers();
  fc.assert(
    fc.property(
      fc.array(
        fc.constantFrom(
          "error",
          "claim",
          "unrelated",
          "focus",
          "blur",
          "dismiss",
        ),
        { minLength: 1, maxLength: 18 },
      ),
      (steps) => {
        const view = mount();
        const expected = new Map<string, { body: string; kind: string }>();
        let held: HTMLButtonElement | null = null;
        steps.forEach((step, index) => {
          if (step === "error" || step === "claim" || step === "unrelated") {
            const id =
              step === "claim" ? `identity.claim.${index}` : `notice.${index}`;
            const body = `message-${index}`;
            arrive(id, body, step === "error" ? "err" : "info");
            expected.set(id, { body, kind: step });
            if (held?.isConnected) expect(document.activeElement).toBe(held);
          } else if (step === "focus") {
            const button = document.querySelector<HTMLButtonElement>(
              ".notice-corner__card .notice-dismiss",
            );
            if (button) {
              act(() => button.focus());
              held = button;
            }
          } else if (step === "blur") {
            act(() =>
              screen.getByRole("textbox", { name: "Current task" }).focus(),
            );
            held = null;
          } else if (held?.isConnected) {
            const name = held.getAttribute("aria-label") ?? "";
            const found = [...expected].find(([, item]) =>
              name.includes(item.body),
            );
            fireEvent.click(held);
            if (found) expected.delete(found[0]);
            held = null;
          }
          expect(listNotices().map((notice) => notice.id)).toEqual([
            ...expected.keys(),
          ]);
          expectLatestVisible(expected);
        });
        view.unmount();
        clearNotices();
        vi.clearAllTimers();
      },
    ),
    { seed: 221125, numRuns: 30 },
  );
});
