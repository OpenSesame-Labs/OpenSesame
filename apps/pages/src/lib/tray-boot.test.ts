/** @vitest-environment jsdom */

import * as connectRoads from "@opensesame/app-core/lib/connect-roads.js";
import * as contributions from "@opensesame/app-core/lib/contributions.js";
import * as persist from "@opensesame/app-core/lib/notice-tray-persist.js";
import {
  clearNotices,
  listNotices,
  setStatusNotice,
} from "@opensesame/app-core/lib/notices.js";
import * as present from "@opensesame/app-core/lib/tutorial-queue-present.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import type { VaultState } from "@opensesame/app-core/lib/vault/store-state.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MINIMAL_CONFIRM_ID,
  dismissMinimalConfirm,
  showMinimalConfirm,
} from "../screens/setup/minimal-confirm.js";
import { bootTrayNotices } from "./tray-boot.js";
import { FINE_POINTER_QUERY, NARROW_QUERY } from "./use-narrow.js";

function lockVault(): void {
  vi.spyOn(vaultStore, "getSnapshot").mockImplementation(
    () =>
      // SAFETY: fixture matches the VaultState contract; boot only checks status.
      ({ status: "locked", guest: false, tomb: "personal" }) as VaultState,
  );
  vi.spyOn(vaultStore, "subscribe").mockImplementation(() => () => {});
}

describe("bootTrayNotices", () => {
  afterEach(() => {
    dismissMinimalConfirm();
    clearNotices();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps a minimal confirm opened while tray history is restoring", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(persist, "restoreTrayNoticeHistory").mockReturnValue(gate);
    lockVault();
    bootTrayNotices();
    showMinimalConfirm(
      () => {},
      () => {},
    );
    release();
    await gate;
    await vi.waitFor(() => {
      expect(
        listNotices().some((notice) => notice.id === MINIMAL_CONFIRM_ID),
      ).toBe(true);
    });
    const kept = listNotices().find(
      (notice) => notice.id === MINIMAL_CONFIRM_ID,
    );
    expect(kept?.act?.label).toBe("Use Minimal anyway");
    expect(kept?.alt?.label).toBe("Keep Default");
  });

  it("drops a restored minimal confirm that has no choices", async () => {
    vi.spyOn(persist, "restoreTrayNoticeHistory").mockImplementation(
      async () => {
        setStatusNotice({
          id: MINIMAL_CONFIRM_ID,
          tone: "warn",
          title: "Minimal",
          body: "Restored without its choices.",
        });
      },
    );
    lockVault();
    bootTrayNotices();
    await vi.waitFor(() => {
      expect(
        listNotices().some((notice) => notice.id === MINIMAL_CONFIRM_ID),
      ).toBe(false);
    });
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
    const contributionListeners = new Set<() => void>();
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
        contributionListeners.add(listener);
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
    expect(contributionListeners.size).toBeGreaterThan(0);
    for (const listener of contributionListeners) listener();
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

  it("refreshes queued tray rows when device form changes", async () => {
    const media = new Map<string, Set<() => void>>();
    let status: VaultState["status"] = "locked";
    vi.spyOn(vaultStore, "getSnapshot").mockImplementation(
      () =>
        // SAFETY: fixture matches the VaultState contract; boot only checks status.
        ({ status, guest: false, tomb: "personal" }) as VaultState,
    );
    vi.spyOn(vaultStore, "subscribe").mockImplementation(() => () => {});
    vi.stubGlobal("matchMedia", (query: string) => {
      let bucket = media.get(query);
      if (!bucket) {
        bucket = new Set<() => void>();
        media.set(query, bucket);
      }
      return {
        media: query,
        matches: false,
        addEventListener: (type: string, listener: () => void) => {
          if (type === "change") bucket?.add(listener);
        },
        removeEventListener: (type: string, listener: () => void) => {
          if (type === "change") bucket?.delete(listener);
        },
      };
    });
    const refresh = vi.spyOn(present, "refreshQueuedTutorialTrayNotices");
    const gate = vi.spyOn(present, "installTutorialQueueLibraryOptions");
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
    const refreshAfterBoot = refresh.mock.calls.length;
    const gateAfterBoot = gate.mock.calls.length;
    const fire = (query: string) => {
      const bucket = media.get(query);
      expect(bucket?.size ?? 0).toBeGreaterThan(0);
      for (const listener of bucket ?? []) listener();
    };

    fire(NARROW_QUERY);
    expect(refresh.mock.calls.length).toBe(refreshAfterBoot);
    expect(gate.mock.calls.length).toBe(gateAfterBoot + 1);

    status = "unlocked";
    fire(NARROW_QUERY);
    expect(refresh.mock.calls.length).toBe(refreshAfterBoot + 1);
    expect(gate.mock.calls.length).toBe(gateAfterBoot + 2);

    fire(FINE_POINTER_QUERY);
    expect(refresh.mock.calls.length).toBe(refreshAfterBoot + 2);
    expect(gate.mock.calls.length).toBe(gateAfterBoot + 3);

    status = "locked";
    fire(NARROW_QUERY);
    expect(refresh.mock.calls.length).toBe(refreshAfterBoot + 2);
    expect(
      listNotices().some((notice) => notice.id.startsWith("tutorial.queue.")),
    ).toBe(false);
  });

  it("refreshes the queue gate when connector roads change", async () => {
    const roadListeners = new Set<() => void>();
    let status: VaultState["status"] = "unlocked";
    vi.spyOn(vaultStore, "getSnapshot").mockImplementation(
      () =>
        // SAFETY: fixture matches the VaultState contract; boot only checks status.
        ({ status, guest: false, tomb: "personal" }) as VaultState,
    );
    vi.spyOn(vaultStore, "subscribe").mockImplementation(() => () => {});
    vi.spyOn(connectRoads, "subscribeConnectRoads").mockImplementation(
      (listener) => {
        roadListeners.add(listener);
        return () => {};
      },
    );
    const refresh = vi.spyOn(present, "refreshQueuedTutorialTrayNotices");
    const gate = vi.spyOn(present, "installTutorialQueueLibraryOptions");
    const rehydrate = vi.spyOn(present, "rehydrateTutorialQueueNotices");
    bootTrayNotices();
    await vi.waitFor(() => expect(rehydrate).toHaveBeenCalled());
    expect(roadListeners.size).toBeGreaterThan(0);
    const refreshAfterBoot = refresh.mock.calls.length;
    const gateAfterBoot = gate.mock.calls.length;

    for (const listener of roadListeners) listener();
    expect(gate.mock.calls.length).toBe(gateAfterBoot + 1);
    expect(refresh.mock.calls.length).toBe(refreshAfterBoot + 1);

    status = "locked";
    for (const listener of roadListeners) listener();
    expect(gate.mock.calls.length).toBe(gateAfterBoot + 2);
    expect(refresh.mock.calls.length).toBe(refreshAfterBoot + 1);
    expect(
      listNotices().some((notice) => notice.id.startsWith("tutorial.queue.")),
    ).toBe(false);
  });
});
