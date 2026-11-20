/** @vitest-environment jsdom */

import * as contributions from "@opensesame/app-core/lib/contributions.js";
import {
  clearNotices,
  listNotices,
  setStatusNotice,
} from "@opensesame/app-core/lib/notices.js";
import * as present from "@opensesame/app-core/lib/tutorial-queue-present.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import type { VaultState } from "@opensesame/app-core/lib/vault/store-state.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootTrayNotices } from "./tray-boot.js";

describe("bootTrayNotices", () => {
  afterEach(() => {
    clearNotices();
    vi.restoreAllMocks();
  });

  it("refreshes the queue gate and tray notices on unlocked vault snapshots", () => {
    const listeners = new Set<() => void>();
    let status: VaultState["status"] = "locked";
    vi.spyOn(vaultStore, "getSnapshot").mockImplementation(
      () =>
        // SAFETY: fixture matches the VaultState contract; boot only checks status.
        ({ status, guest: false, tomb: "personal" }) as VaultState,
    );
    vi.spyOn(vaultStore, "subscribe").mockImplementation((listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    });
    const refresh = vi.spyOn(present, "refreshQueuedTutorialTrayNotices");
    const gate = vi.spyOn(present, "installTutorialQueueLibraryOptions");
    bootTrayNotices();
    const emit = () => {
      for (const listener of listeners) listener();
    };
    const refreshAfterBoot = refresh.mock.calls.length;
    const gateAfterBoot = gate.mock.calls.length;

    emit();
    expect(refresh.mock.calls.length).toBe(refreshAfterBoot);
    expect(gate.mock.calls.length).toBe(gateAfterBoot);

    status = "unlocked";
    emit();
    expect(refresh.mock.calls.length).toBe(refreshAfterBoot + 1);
    expect(gate.mock.calls.length).toBe(gateAfterBoot + 1);

    emit();
    expect(refresh.mock.calls.length).toBe(refreshAfterBoot + 2);
    expect(gate.mock.calls.length).toBe(gateAfterBoot + 2);

    status = "locked";
    emit();
    expect(refresh.mock.calls.length).toBe(refreshAfterBoot + 2);
    expect(gate.mock.calls.length).toBe(gateAfterBoot + 2);
  });

  it("suppresses queued tutorial rows until the vault is unlocked", async () => {
    const listeners = new Set<() => void>();
    let contributionListener: (() => void) | null = null;
    let status: VaultState["status"] = "locked";
    vi.spyOn(vaultStore, "getSnapshot").mockImplementation(
      () =>
        // SAFETY: fixture matches the VaultState contract; boot only checks status.
        ({ status, guest: false, tomb: "personal" }) as VaultState,
    );
    vi.spyOn(vaultStore, "subscribe").mockImplementation((listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    });
    vi.spyOn(contributions, "subscribeContributions").mockImplementation(
      (listener) => {
        contributionListener = listener;
        return () => {};
      },
    );
    const refresh = vi.spyOn(present, "refreshQueuedTutorialTrayNotices");
    const rehydrate = vi.spyOn(present, "rehydrateTutorialQueueNotices");
    setStatusNotice({
      id: "tutorial.queue.vault.lock",
      tone: "info",
      title: "Lock the vault",
      body: "Queued.",
    });
    bootTrayNotices();
    await vi.waitFor(() => {
      expect(
        listNotices().some(
          (notice) => notice.id === "tutorial.queue.vault.lock",
        ),
      ).toBe(false);
    });
    expect(rehydrate).not.toHaveBeenCalled();
    const refreshWhileLocked = refresh.mock.calls.length;

    setStatusNotice({
      id: "tutorial.queue.settings.danger.review",
      tone: "info",
      title: "Danger",
      body: "Queued.",
    });
    contributionListener?.();
    expect(
      listNotices().some(
        (notice) => notice.id === "tutorial.queue.settings.danger.review",
      ),
    ).toBe(false);
    expect(refresh.mock.calls.length).toBe(refreshWhileLocked);

    status = "unlocked";
    for (const listener of listeners) listener();
    expect(refresh.mock.calls.length).toBe(refreshWhileLocked + 1);
    expect(rehydrate).not.toHaveBeenCalled();
  });
});
