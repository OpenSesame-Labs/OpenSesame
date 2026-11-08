/** @vitest-environment jsdom */
import type { VaultItem } from "@opensesame/vault-core";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  STORAGE_RISK_NOTICE_ID,
  storageRiskSeams,
  useStorageRiskNotice,
} from "./storage-risk-notice.js";

const item = { id: "i1", deletedAt: null } as unknown as VaultItem;
const trashed = { id: "i2", deletedAt: "2026-01-01" } as unknown as VaultItem;

const original = { ...storageRiskSeams };
let setNotice: ReturnType<typeof vi.fn>;
let dismiss: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setNotice = vi.fn();
  dismiss = vi.fn();
  Object.assign(storageRiskSeams, {
    getBackupStatus: async () => ({ target: null, pendingEvents: 0 }),
    storagePersisted: async () => false,
    setStatusNotice: setNotice,
    dismissNotice: dismiss,
  });
});

afterEach(() => {
  Object.assign(storageRiskSeams, original);
});

describe("the browser-storage warning", () => {
  it("warns on unlock when items are sealed with no backup and no persistence", async () => {
    renderHook(() => useStorageRiskNotice("unlocked", "personal", [item]));
    await waitFor(() => expect(setNotice).toHaveBeenCalledTimes(1));
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

  it("stays silent when a backup is enabled or storage is persistent", async () => {
    Object.assign(storageRiskSeams, {
      getBackupStatus: async () => ({
        target: { enabled: true },
        pendingEvents: 0,
      }),
    });
    const { unmount } = renderHook(() =>
      useStorageRiskNotice("unlocked", "personal", [item]),
    );
    await Promise.resolve();
    expect(setNotice).not.toHaveBeenCalled();
    unmount();

    Object.assign(storageRiskSeams, {
      getBackupStatus: async () => ({ target: null, pendingEvents: 0 }),
      storagePersisted: async () => true,
    });
    renderHook(() => useStorageRiskNotice("unlocked", "personal", [item]));
    await Promise.resolve();
    expect(setNotice).not.toHaveBeenCalled();
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
