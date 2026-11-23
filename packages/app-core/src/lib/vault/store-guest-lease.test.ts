import { createItem } from "@opensesame/vault-core";
import { expect, it, vi } from "vitest";
import * as guestVaultIds from "../guest-vault-id.js";
import { kvGet } from "../kv.js";
import { HEADER_PATH, tombFileKey, unregisterTomb, vfsFlush } from "../vfs.js";
import * as guestMaterial from "./store-guest-material.js";
import { newStore } from "./store-ops.fixture.js";
import * as tombDestruction from "./store-tomb-destruction.js";
import {
  deferred,
  holdGuestLease,
  installUnlockRacesFixture,
} from "./store-unlock-races.fixture.js";
import * as sharedLocks from "./vault-shared-locks.js";

installUnlockRacesFixture();

it("does not open a guest vault after a lock while its lease is pending", async () => {
  const store = newStore();
  const held = holdGuestLease();
  const opening = store.createGuest();
  const refused = expect(opening).rejects.toThrow(/generation changed/i);
  await held.started;
  const tomb = vi.mocked(sharedLocks.acquireExclusiveGuestLease).mock
    .calls[0]?.[0];
  if (!tomb) throw new Error("The guest lease was not requested.");
  try {
    store.lock();
    held.release();
    await refused;
    await held.released;
    expect(store.isUnlocked()).toBe(false);
    await expect(
      sharedLocks.withExclusiveOpenLease(tomb, async () => true),
    ).resolves.toBe(true);
  } finally {
    held.release();
    await refused;
  }
});

it("never deletes a protected vault if a temporary guest tomb name collides", async () => {
  const protectedGuest = newStore();
  await protectedGuest.createGuest();
  const tomb = protectedGuest.activeTomb();
  await protectedGuest.saveItem(createItem("note", "Protected content"));
  await protectedGuest.enrollPin("48291037");
  protectedGuest.lock();
  await vfsFlush();

  vi.spyOn(guestVaultIds, "newGuestVaultId").mockReturnValueOnce(tomb);
  const temporaryGuest = newStore();
  await temporaryGuest.createGuest({
    guestPerson: { id: "local_guest_collision", name: "guest-999" },
  });
  expect(temporaryGuest.activeTomb()).toBe(tomb);
  await temporaryGuest.destroy();

  protectedGuest.prepareGuestUnlock(tomb);
  await protectedGuest.unlockWithPin("48291037");
  expect(protectedGuest.getSnapshot().items.map((item) => item.name)).toContain(
    "Protected content",
  );
  protectedGuest.lock();
});

it("refuses promotion over a protected guest missing from the registry", async () => {
  const protectedGuest = newStore();
  await protectedGuest.createGuest();
  const tomb = protectedGuest.activeTomb();
  await protectedGuest.saveItem(createItem("note", "Protected content"));
  await protectedGuest.enrollPin("48291037");
  protectedGuest.lock();
  await vfsFlush();
  await unregisterTomb(tomb);
  const header = kvGet(tombFileKey(tomb, HEADER_PATH));

  vi.spyOn(guestVaultIds, "newGuestVaultId").mockReturnValueOnce(tomb);
  const temporaryGuest = newStore();
  await temporaryGuest.createGuest();
  await expect(temporaryGuest.enrollPin("73512480")).rejects.toThrow(
    /already exists/i,
  );
  expect(kvGet(tombFileKey(tomb, HEADER_PATH))).toBe(header);
  await temporaryGuest.destroy();

  protectedGuest.prepareGuestUnlock(tomb);
  await protectedGuest.unlockWithPin("48291037");
  expect(protectedGuest.getSnapshot().items.map((item) => item.name)).toContain(
    "Protected content",
  );
  protectedGuest.lock();
});

it("does not replace a newer guest when an earlier destruction finishes", async () => {
  const store = newStore();
  await store.createGuest();
  const started = deferred();
  const gate = deferred();
  const destroy = tombDestruction.destroyStoredTomb;
  vi.spyOn(tombDestruction, "destroyStoredTomb").mockImplementationOnce(
    async (...args) => {
      started.release();
      await gate.promise;
      await destroy(...args);
    },
  );
  const destroying = store.destroy();
  await started.promise;
  try {
    await store.createGuest();
    const replacement = store.activeTomb();
    gate.release();
    await destroying;
    expect(store.isUnlocked()).toBe(true);
    expect(store.activeTomb()).toBe(replacement);
  } finally {
    gate.release();
    await destroying;
    store.lock();
  }
});

it("does not publish a guest if lock wins immediately after preparation", async () => {
  const store = newStore();
  const prepare = guestMaterial.prepareGuestOpen;
  let tomb = "";
  vi.spyOn(guestMaterial, "prepareGuestOpen").mockImplementationOnce(
    async (...args) => {
      const opened = await prepare(...args);
      tomb = opened.scope.tomb;
      queueMicrotask(() => store.lock());
      return opened;
    },
  );
  await expect(store.createGuest()).rejects.toThrow();
  expect(store.isUnlocked()).toBe(false);
  await expect(
    sharedLocks.withExclusiveOpenLease(tomb, async () => true),
  ).resolves.toBe(true);
});
