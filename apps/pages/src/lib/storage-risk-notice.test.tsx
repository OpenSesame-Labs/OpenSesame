/** @vitest-environment jsdom */
import type { VaultItem } from "@opensesame/vault-core";
import { act, renderHook, waitFor } from "@testing-library/react";
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
    hasWorkingBackupTarget: () => false,
    hasCatchingUpBackupTarget: () => false,
    automaticBackupAllowed: () => true,
    newestWorkingBackupSync: () => null,
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

  // Which target states count as "working" (never synced, failing, behind,
  // a healthy second row) is pinned where the predicate lives:
  // packages/app-core/src/lib/backup.test.ts (`hasWorkingBackupTarget`).
  it("stays silent when a backup target is working", async () => {
    Object.assign(storageRiskSeams, {
      hasWorkingBackupTarget: () => true,
    });
    renderHook(() => useStorageRiskNotice("unlocked", "personal", [item]));
    await Promise.resolve();
    expect(setNotice).not.toHaveBeenCalled();
  });

  it("withdraws once a backup starts working, without waiting for unlock", async () => {
    vi.useFakeTimers();
    try {
      let working = false;
      Object.assign(storageRiskSeams, {
        hasWorkingBackupTarget: () => working,
      });
      renderHook(() => useStorageRiskNotice("unlocked", "personal", [item]));
      await act(async () => {
        await Promise.resolve();
      });
      expect(setNotice).toHaveBeenCalledTimes(1);
      working = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(dismiss).toHaveBeenCalledWith(STORAGE_RISK_NOTICE_ID);
    } finally {
      vi.useRealTimers();
    }
  });

  it("withdraws the moment a target reports working, ahead of the poll", async () => {
    let working = false;
    let changed: (() => void) | undefined;
    Object.assign(storageRiskSeams, {
      hasWorkingBackupTarget: () => working,
      subscribeLocalBackupTarget: (listener: () => void) => {
        changed = listener;
        return () => {
          changed = undefined;
        };
      },
    });
    renderHook(() => useStorageRiskNotice("unlocked", "personal", [item]));
    await waitFor(() => expect(setNotice).toHaveBeenCalledTimes(1));
    working = true;
    act(() => changed?.());
    expect(dismiss).toHaveBeenCalledWith(STORAGE_RISK_NOTICE_ID);
  });

  it("lets a target that has synced before catch up, and warns only if it stays behind", async () => {
    // Every vault change queues events before the sync that sends them, so
    // a healthy target is behind at each unlock and each save.
    vi.useFakeTimers();
    try {
      Object.assign(storageRiskSeams, {
        hasCatchingUpBackupTarget: () => true,
      });
      renderHook(() => useStorageRiskNotice("unlocked", "personal", [item]));
      await act(async () => {
        await Promise.resolve();
      });
      expect(setNotice).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(setNotice).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says the backup is older than the vault when automatic backup is held and something was saved since", async () => {
    // A plan that holds automatic backup never sends a save anywhere, so the
    // target stays "caught up" by its own count however much is saved.
    // SAFETY: fixture item — the checked hook reads only `deletedAt` and `updatedAt` on this seam.
    const saved = {
      id: "i3",
      deletedAt: null,
      updatedAt: "2026-03-02T00:00:00Z",
    } as VaultItem;
    let synced = "2026-03-01T00:00:00Z";
    Object.assign(storageRiskSeams, {
      hasWorkingBackupTarget: () => true,
      automaticBackupAllowed: () => false,
      newestWorkingBackupSync: () => synced,
    });
    const first = renderHook(() =>
      useStorageRiskNotice("unlocked", "personal", [saved]),
    );
    await waitFor(() => expect(setNotice).toHaveBeenCalledTimes(1));
    // SAFETY: the seam is this suite's own vi.fn; the recorded call matches the notice input contract.
    const input = setNotice.mock.calls[0]?.[0] as {
      title: string;
      body: string;
    };
    expect(input.title).toBe("The backup is older than this vault");
    // A copy exists: the words never claim there is none.
    expect(input.body).not.toContain("no copy anywhere else");
    first.unmount();
    setNotice.mockClear();
    // Synced by hand after the last save: the copy holds what the vault holds.
    synced = "2026-03-03T00:00:00Z";
    renderHook(() => useStorageRiskNotice("unlocked", "personal", [saved]));
    await Promise.resolve();
    expect(setNotice).not.toHaveBeenCalled();
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
