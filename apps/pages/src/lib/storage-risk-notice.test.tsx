/** @vitest-environment jsdom */
import type { VaultItem } from "@opensesame/vault-core";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  STORAGE_RISK_NOTICE_ID,
  storageRiskSeams,
  useStorageRiskNotice,
} from "./storage-risk-notice.js";

// SAFETY: fixture item — the checked hook reads only `deletedAt` on this seam.
const item = { id: "i1", deletedAt: null } as VaultItem;
// SAFETY: fixture item — the checked hook reads only `deletedAt` on this seam.
const trashed = { id: "i2", deletedAt: "2026-01-01" } as VaultItem;

const original = { ...storageRiskSeams };
let setNotice: ReturnType<typeof vi.fn>;
let dismiss: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setNotice = vi.fn();
  dismiss = vi.fn();
  Object.assign(storageRiskSeams, {
    getBackupStatus: async () => ({ target: null, pendingEvents: 0 }),
    setStatusNotice: setNotice,
    dismissNotice: dismiss,
  });
});

afterEach(() => {
  Object.assign(storageRiskSeams, original);
});

describe("the browser-storage warning", () => {
  it("warns on unlock when items are sealed with no working backup", async () => {
    renderHook(() => useStorageRiskNotice("unlocked", "personal", [item]));
    await waitFor(() => expect(setNotice).toHaveBeenCalledTimes(1));
    // SAFETY: the seam is this suite's own vi.fn; the recorded call matches the notice input contract.
    const input = setNotice.mock.calls[0]?.[0] as {
      id: string;
      body: string;
    };
    expect(input.id).toBe(STORAGE_RISK_NOTICE_ID);
    // Precise about the mechanism: site data, never a bare cache clear.
    expect(input.body).toContain("Clearing this site's data");
    expect(input.body).not.toMatch(/clearing your cache/i);
  });

  it("stays silent for an empty vault, a guest, and while locked", async () => {
    renderHook(() => useStorageRiskNotice("unlocked", "personal", []));
    renderHook(() => useStorageRiskNotice("unlocked", "guest", [item], true));
    renderHook(() => useStorageRiskNotice("locked", "personal", [item]));
    renderHook(() => useStorageRiskNotice("unlocked", "personal", [trashed]));
    await Promise.resolve();
    expect(setNotice).not.toHaveBeenCalled();
  });

  it("stays silent only when a backup is enabled, error-free and caught up", async () => {
    Object.assign(storageRiskSeams, {
      getBackupStatus: async () => ({
        target: { enabled: true, lastError: null },
        pendingEvents: 0,
      }),
    });
    renderHook(() => useStorageRiskNotice("unlocked", "personal", [item]));
    await Promise.resolve();
    expect(setNotice).not.toHaveBeenCalled();
  });

  it("warns when the backup is enabled but failing or behind", async () => {
    Object.assign(storageRiskSeams, {
      getBackupStatus: async () => ({
        target: { enabled: true, lastError: "push rejected" },
        pendingEvents: 3,
      }),
    });
    renderHook(() => useStorageRiskNotice("unlocked", "personal", [item]));
    await waitFor(() => expect(setNotice).toHaveBeenCalledTimes(1));
  });

  it("opens the export sheet from the notice's own act", async () => {
    const onExport = vi.fn();
    renderHook(() =>
      useStorageRiskNotice("unlocked", "personal", [item], false, onExport),
    );
    await waitFor(() => expect(setNotice).toHaveBeenCalledTimes(1));
    // SAFETY: the seam is this suite's own vi.fn; the recorded call matches the notice input contract.
    const input = setNotice.mock.calls[0]?.[0] as {
      act?: { label: string; run: () => void };
    };
    expect(input.act?.label).toBe("Export a copy");
    input.act?.run();
    expect(onExport).toHaveBeenCalledTimes(1);
  });

  it("fires when the first item is sealed, and withdraws on lock", async () => {
    let items: VaultItem[] = [];
    let status = "unlocked";
    const { rerender } = renderHook(() =>
      useStorageRiskNotice(status, "personal", items),
    );
    items = [item];
    rerender();
    await waitFor(() => expect(setNotice).toHaveBeenCalledTimes(1));
    status = "locked";
    rerender();
    expect(dismiss).toHaveBeenCalledWith(STORAGE_RISK_NOTICE_ID);
  });
});
