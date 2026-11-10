/** @vitest-environment jsdom */
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import type { VaultItem } from "@opensesame/vault-core";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, type AppSlots } from "./App.js";
import {
  STORAGE_RISK_NOTICE_ID,
  storageRiskSeams,
} from "./lib/storage-risk-notice.js";

// SAFETY: fixture item — the storage-risk hook reads only `deletedAt` on this seam.
const item = { id: "i1", deletedAt: null } as VaultItem;

const env = { vaultStatus: "unlocked" };
const originalSeams = { ...storageRiskSeams };

const slots: Partial<AppSlots> = {
  hasAuthResponse: () => false,
  useVault: () => ({
    status: env.vaultStatus,
    tomb: "personal",
    guest: false,
    items: [item],
  }),
  useTheme: () => {},
  useSessionGuards: () => {},
  useRouteContributions: () => [],
  useUnlockEffects: () => [],
  useShellWrappers: () => [],
  recoverPendingFederatedLink: () => {},
  AppShell: ({ children }) => <div data-testid="app-shell">{children}</div>,
  UnlockScreen: () => <p>unlock screen stub</p>,
  VaultSection: () => <p>vault section</p>,
};

function app() {
  return (
    <MemoryRouter initialEntries={["/vault"]}>
      <App slots={slots} />
    </MemoryRouter>
  );
}

beforeEach(() => {
  env.vaultStatus = "unlocked";
  clearNotices();
  Object.assign(storageRiskSeams, {
    hasWorkingBackupTarget: () => false,
    hasCatchingUpBackupTarget: () => false,
  });
});

afterEach(() => {
  cleanup();
  clearNotices();
  Object.assign(storageRiskSeams, originalSeams);
  vi.restoreAllMocks();
});

describe("the export sheet the storage warning opens", () => {
  it("closes when the vault locks and does not come back on unlock", async () => {
    const view = render(app());
    await waitFor(() =>
      expect(
        listNotices().some((notice) => notice.id === STORAGE_RISK_NOTICE_ID),
      ).toBe(true),
    );
    const notice = listNotices().find(
      (entry) => entry.id === STORAGE_RISK_NOTICE_ID,
    );
    act(() => notice?.act?.run());
    expect(
      screen.getByRole("dialog", { name: "Export encrypted vault" }),
    ).toBeTruthy();

    // Nothing may stand in front of the first screen (ADR 0090).
    env.vaultStatus = "locked";
    view.rerender(app());
    expect(screen.getByText("unlock screen stub")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();

    env.vaultStatus = "unlocked";
    view.rerender(app());
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
