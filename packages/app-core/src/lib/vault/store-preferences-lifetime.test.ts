import { mintVaultKey } from "@opensesame/vault-core";
import { expect, it } from "vitest";
import { installFileBackedVfs } from "../secret-fs/install.js";
import { makeMemorySecretFiles } from "../secret-fs/memory.js";
import { lockTomb, unlockTomb } from "../vfs.js";
import { StorePreferences } from "./store-preferences.js";
import { deferred } from "./store-unlock-races.fixture.js";

it("does not save queued preferences into a later unlock using the same key", async () => {
  const gate = deferred();
  const files = makeMemorySecretFiles();
  const restore = await installFileBackedVfs(files);
  const { vaultKey, rawVaultKey } = await mintVaultKey();
  rawVaultKey.fill(0);
  const tomb = "preferences-owner";
  unlockTomb(tomb, vaultKey);
  const preferences = new StorePreferences();
  preferences.prefs = { ...preferences.prefs, theme: "dark" };
  let changed = false;
  const pending = preferences.persist(
    tomb,
    gate.promise,
    () => tomb,
    () => {
      changed = true;
    },
  );
  try {
    lockTomb(tomb);
    unlockTomb(tomb, vaultKey);
    gate.release();
    await pending;
    expect(files.snapshot().size).toBe(0);
    expect(changed).toBe(false);
  } finally {
    gate.release();
    lockTomb(tomb);
    restore();
  }
});
