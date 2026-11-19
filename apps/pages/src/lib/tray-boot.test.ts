/** @vitest-environment jsdom */

import * as present from "@opensesame/app-core/lib/tutorial-queue-present.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import type { VaultState } from "@opensesame/app-core/lib/vault/store-state.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootTrayNotices } from "./tray-boot.js";

describe("bootTrayNotices", () => {
  afterEach(() => {
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
});
