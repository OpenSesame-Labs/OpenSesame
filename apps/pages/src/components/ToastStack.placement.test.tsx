/** @vitest-environment jsdom */
import {
  registerDraftSaver,
  resetDirtyEdits,
} from "@opensesame/app-core/lib/dirty-edit.js";
import { showToast } from "@opensesame/app-core/lib/notice-toast.js";
import {
  appendStatusNotice,
  clearNotices,
  listNotices,
} from "@opensesame/app-core/lib/notices.js";
import type { GuideRuntimeSnapshot } from "@opensesame/guide-runtime";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { SupportContext } from "../tutorial/support-context.js";
import { stubSupportController } from "../tutorial/support-controller.test-support.js";
import { ToastStack } from "./ToastStack.js";

afterEach(() => {
  cleanup();
  resetDirtyEdits();
  clearNotices();
  vi.unstubAllGlobals();
});

it("keeps persistent tray notices from covering a phone's controls", () => {
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  render(
    <MemoryRouter>
      <ToastStack />
    </MemoryRouter>,
  );
  act(() => {
    appendStatusNotice({
      id: "recommend.backups",
      tone: "info",
      title: "Back up this vault",
      body: "Set up a backup.",
      act: { label: "Set up backups", worded: true, run: () => {} },
    });
  });
  expect(screen.queryByText("Back up this vault")).toBeNull();
  expect(
    listNotices().some((notice) => notice.id === "recommend.backups"),
  ).toBe(true);
});

it("still announces new notices when hidden offers fill the phone stack", () => {
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  render(
    <MemoryRouter>
      <ToastStack />
    </MemoryRouter>,
  );
  act(() => {
    for (const id of ["backup", "autofill"]) {
      appendStatusNotice({
        id,
        tone: "info",
        title: `Offer ${id}`,
        body: "A recommendation.",
        act: { label: "Set up", worded: true, run: () => {} },
      });
    }
    appendStatusNotice({
      id: "reset",
      tone: "warn",
      title: "Password reset needs you",
      body: "Continue the reset.",
    });
  });
  expect(screen.queryByText("Offer backup")).toBeNull();
  expect(screen.queryByText("Offer autofill")).toBeNull();
  expect(screen.getByText("Password reset needs you")).toBeTruthy();
});

it("defers an offer while an editor or tutorial needs its controls", () => {
  const { support, set } = stubSupportController("/vault");
  const guide: GuideRuntimeSnapshot = {
    status: "running",
    goal: "vault.item.first",
    index: 0,
    total: 1,
    runId: 1,
    message: null,
    error: null,
    tour: {
      step: 1,
      count: 1,
      kind: "narrate",
      message: "Create an account.",
      target: null,
      side: null,
      action: false,
      degraded: false,
      canBack: false,
    },
  };
  render(
    <MemoryRouter>
      <SupportContext.Provider value={support}>
        <ToastStack />
      </SupportContext.Provider>
    </MemoryRouter>,
  );
  act(() =>
    showToast({
      id: "backup-offer",
      tone: "info",
      title: "Back up this vault",
      body: "Set up a backup.",
      sticky: true,
    }),
  );
  expect(screen.getByText("Back up this vault")).toBeTruthy();
  let closeEditor = () => {};
  act(() => {
    closeEditor = registerDraftSaver("editor", () => true);
  });
  expect(screen.queryByText("Back up this vault")).toBeNull();
  act(() => {
    set({ guide });
    closeEditor();
  });
  expect(screen.queryByText("Back up this vault")).toBeNull();
  act(() => {
    set({ guide: null });
  });
  expect(screen.getByText("Back up this vault")).toBeTruthy();
});

it("shows notices during editing even when deferred offers fill the queue", () => {
  render(
    <MemoryRouter>
      <ToastStack />
    </MemoryRouter>,
  );
  let closeEditor = () => {};
  act(() => {
    closeEditor = registerDraftSaver("editor", () => true);
    for (const id of ["backup", "autofill"]) {
      showToast({
        id,
        tone: "info",
        title: `Offer ${id}`,
        body: "A recommendation.",
        sticky: true,
      });
    }
    showToast({
      id: "reset",
      tone: "warn",
      title: "Password reset needs you",
      body: "Continue the reset.",
    });
  });
  expect(screen.queryByText("Offer backup")).toBeNull();
  expect(screen.getByText("Password reset needs you")).toBeTruthy();
  act(() => closeEditor());
  expect(document.querySelectorAll(".toast").length).toBeLessThanOrEqual(2);
});
