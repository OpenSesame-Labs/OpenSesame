import { beforeEach, describe, expect, it } from "vitest";
import { kvDelete } from "../kv.js";
import { defaultPrefs, normalizeVaultPrefs } from "./store.js";
import { LEGACY_PREFS_KEY as PREFS_KEY } from "./tomb-migration.js";

describe("vault prefs locking defaults", () => {
  beforeEach(() => {
    kvDelete(PREFS_KEY);
  });

  it("defaults auto-lock to off and does not sign out on lock", () => {
    expect(defaultPrefs.autoLockMinutes).toBe(0);
    expect(defaultPrefs.signOutOnLock).toBe(false);
    expect(defaultPrefs.lockOnHide).toBe(false);
  });

  it("migrates the old 15-minute default to Never once", () => {
    const migrated = normalizeVaultPrefs({
      autoLockMinutes: 15,
      lockOnHide: false,
      clipboardClearSeconds: 30,
      theme: "system",
    });
    expect(migrated.autoLockMinutes).toBe(0);
    expect(migrated.signOutOnLock).toBe(false);
    expect(migrated.prefsRevision).toBeGreaterThanOrEqual(2);
  });

  it("keeps an explicit 15-minute choice after the prefs revision is current", () => {
    const kept = normalizeVaultPrefs({
      autoLockMinutes: 15,
      lockOnHide: false,
      clipboardClearSeconds: 30,
      theme: "dark",
      prefsRevision: 2,
      signOutOnLock: true,
    });
    expect(kept.autoLockMinutes).toBe(15);
    expect(kept.signOutOnLock).toBe(true);
    expect(kept.theme).toBe("dark");
  });
});
