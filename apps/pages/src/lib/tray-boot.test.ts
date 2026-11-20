/** @vitest-environment jsdom */

import * as connectRoads from "@opensesame/app-core/lib/connect-roads.js";
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
import { FINE_POINTER_QUERY, NARROW_QUERY } from "./use-narrow.js";

describe("bootTrayNotices", () => {
  afterEach(() => {
    clearNotices();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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
    let roadListener: (() => void) | null = null;
    let status: VaultState["status"] = "unlocked";
    vi.spyOn(vaultStore, "getSnapshot").mockImplementation(
      () =>
        // SAFETY: fixture matches the VaultState contract; boot only checks status.
        ({ status, guest: false, tomb: "personal" }) as VaultState,
    );
    vi.spyOn(vaultStore, "subscribe").mockImplementation(() => () => {});
    vi.spyOn(connectRoads, "subscribeConnectRoads").mockImplementation(
      (listener) => {
        roadListener = listener;
        return () => {};
      },
    );
    const refresh = vi.spyOn(present, "refreshQueuedTutorialTrayNotices");
    const gate = vi.spyOn(present, "installTutorialQueueLibraryOptions");
    const rehydrate = vi.spyOn(present, "rehydrateTutorialQueueNotices");
    bootTrayNotices();
    await vi.waitFor(() => expect(rehydrate).toHaveBeenCalled());
    expect(roadListener).not.toBeNull();
    const refreshAfterBoot = refresh.mock.calls.length;
    const gateAfterBoot = gate.mock.calls.length;

    roadListener?.();
    expect(gate.mock.calls.length).toBe(gateAfterBoot + 1);
    expect(refresh.mock.calls.length).toBe(refreshAfterBoot + 1);

    status = "locked";
    roadListener?.();
    expect(gate.mock.calls.length).toBe(gateAfterBoot + 2);
    expect(refresh.mock.calls.length).toBe(refreshAfterBoot + 1);
    expect(
      listNotices().some((notice) => notice.id.startsWith("tutorial.queue.")),
    ).toBe(false);
  });
});
