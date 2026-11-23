import { afterEach, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
import {
  loadGuestGithubApp,
  removeGuestGithubApp,
  reserveGuestGithubItemId,
  saveGuestGithubApp,
} from "./github-app-guest.js";
import { kvForgetAll } from "./kv.js";
import { vaultStore } from "./vault/store.js";
import { INDEX_PATH, tombFileKey, vfsFlush, vfsSeams } from "./vfs.js";

afterEach(async () => {
  vaultStore.lock();
  await vfsFlush();
  vi.restoreAllMocks();
  kvForgetAll();
  configureHost(createTestHost());
});

it("reuses the original item after a body commit reports an index failure", async () => {
  configureHost(
    createTestHost({ locks: webLocksDouble(), originFiles: undefined }),
  );
  vaultStore.lock();
  await vfsFlush();
  kvForgetAll();
  await vaultStore.createGuest();
  const tomb = vaultStore.activeTomb();
  await vaultStore.enrollPin("48291037");
  const app = {
    id: "12",
    key: "github-oauth",
    displayName: "Example",
    htmlUrl: null,
    ownerLogin: null,
    ownerType: null,
    installedByLogin: null,
    installations: [],
  };
  const itemId = reserveGuestGithubItemId();
  const write = vfsSeams.writeRawGuarded;
  if (!write) throw new Error("Missing guarded write");
  let fail = true;
  vi.spyOn(vfsSeams, "writeRawGuarded").mockImplementation(
    async (key, ...args) => {
      if (fail && key === tombFileKey(tomb, INDEX_PATH)) {
        fail = false;
        throw new Error("index unavailable");
      }
      return write(key, ...args);
    },
  );
  await expect(
    saveGuestGithubApp(app, "private-key", () => {}, itemId),
  ).rejects.toThrow("index unavailable");
  await saveGuestGithubApp(app, "private-key", () => {}, itemId);
  expect(
    vaultStore
      .getSnapshot()
      .items.filter(
        (item) => item.kind === "secret" && item.name === "Example",
      ),
  ).toHaveLength(1);
  await removeGuestGithubApp();
  expect(await loadGuestGithubApp(tomb, () => {})).toBeNull();
});

it("does not purge an item edited after a failed removal", async () => {
  configureHost(
    createTestHost({ locks: webLocksDouble(), originFiles: undefined }),
  );
  vaultStore.lock();
  await vfsFlush();
  kvForgetAll();
  await vaultStore.createGuest();
  const tomb = vaultStore.activeTomb();
  const app = {
    id: "12",
    key: "github-oauth",
    displayName: "Example",
    htmlUrl: null,
    ownerLogin: null,
    ownerType: null,
    installedByLogin: null,
    installations: [],
  };
  await saveGuestGithubApp(app, "original", () => {});
  vi.spyOn(vaultStore, "purgeItemIfUnchanged").mockRejectedValueOnce(
    new Error("storage unavailable"),
  );
  await expect(removeGuestGithubApp()).rejects.toThrow("storage unavailable");
  const item = vaultStore
    .getSnapshot()
    .items.find((entry) => entry.kind === "secret" && entry.name === "Example");
  if (item?.kind !== "secret") throw new Error("Missing App item");
  await vaultStore.saveItems([{ ...item, value: "edited" }]);
  expect(await loadGuestGithubApp(tomb, () => {})).toMatchObject({ id: "12" });
  expect(
    vaultStore.getSnapshot().items.find((entry) => entry.id === item.id),
  ).toMatchObject({ value: "edited" });
});
