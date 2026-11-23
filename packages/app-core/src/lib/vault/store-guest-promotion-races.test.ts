import { createItem } from "@opensesame/vault-core";
import { expect, it, vi } from "vitest";
import * as kv from "../kv.js";
import { kvGet, kvSeams } from "../kv.js";
import {
  HEADER_PATH,
  TOMBS_REGISTRY_KEY,
  listTombs,
  tombFileKey,
  vfsSeams,
} from "../vfs.js";
import { newStore } from "./store-ops.fixture.js";
import {
  deferred,
  installUnlockRacesFixture,
} from "./store-unlock-races.fixture.js";

installUnlockRacesFixture();

it("does not publish or retain a half-protected guest after lock interrupts header publication", async () => {
  const store = newStore();
  await store.createGuest();
  const tomb = store.activeTomb();
  const started = deferred();
  const gate = deferred();
  const actual = kvSeams.kvSetDurable;
  vi.spyOn(kvSeams, "kvSetDurable").mockImplementation(
    async (key, value, check) => {
      if (key === tombFileKey(tomb, HEADER_PATH)) {
        started.release();
        await gate.promise;
      }
      await actual(key, value, check);
    },
  );
  const enrolling = store.enrollPin("48291037");
  const refused = expect(enrolling).rejects.toThrow();
  await started.promise;
  try {
    store.lock();
    gate.release();
    await refused;
    expect(kvGet(tombFileKey(tomb, HEADER_PATH))).toBeNull();
    expect(listTombs()).not.toContain(tomb);
    expect(store.isUnlocked()).toBe(false);
  } finally {
    gate.release();
    await refused;
  }
});

it("freezes edits after an uncertain header commit and safely retries protection", async () => {
  const store = newStore();
  await store.createGuest();
  const tomb = store.activeTomb();
  await store.saveItem(createItem("note", "Before protection"));
  const header = tombFileKey(tomb, HEADER_PATH);
  const set = kvSeams.kvSetDurable;
  const refresh = kv.kvRefresh;
  let uncertain = false;
  let failOnce = true;
  vi.spyOn(kv, "kvRefresh").mockImplementation(async (key, limit, check) => {
    if (uncertain && key === header) throw new Error("storage unavailable");
    return refresh(key, limit, check);
  });
  vi.spyOn(kvSeams, "kvSetDurable").mockImplementation(
    async (key, value, check) => {
      await set(key, value, check);
      if (key === header && failOnce) {
        failOnce = false;
        uncertain = true;
        throw new Error("storage returned an ambiguous result");
      }
    },
  );
  await expect(store.enrollPin("48291037")).rejects.toThrow("ambiguous");
  uncertain = false;
  await expect(
    store.saveItem(createItem("note", "Must not be lost")),
  ).rejects.toThrow(/protect/i);
  await store.enrollPin("73920481");
  store.lock();
  store.prepareGuestUnlock(tomb);
  await store.unlockWithPin("73920481");
  expect(store.getSnapshot().items.map((item) => item.name)).toContain(
    "Before protection",
  );
  expect(store.getSnapshot().items.map((item) => item.name)).not.toContain(
    "Must not be lost",
  );
  store.lock();
});

it("can reopen the original protected guest after locking during an uncertain commit", async () => {
  const store = newStore();
  await store.createGuest();
  const tomb = store.activeTomb();
  await store.saveItem(createItem("note", "Recovered after lock"));
  const header = tombFileKey(tomb, HEADER_PATH);
  const set = kvSeams.kvSetDurable;
  const refresh = kv.kvRefresh;
  let uncertain = false;
  vi.spyOn(kv, "kvRefresh").mockImplementation(async (key, limit, check) => {
    if (uncertain && key === header) throw new Error("storage unavailable");
    return refresh(key, limit, check);
  });
  vi.spyOn(kvSeams, "kvSetDurable").mockImplementation(
    async (key, value, check) => {
      await set(key, value, check);
      if (key === header) {
        uncertain = true;
        throw new Error("storage returned an ambiguous result");
      }
    },
  );
  await expect(store.enrollPin("48291037")).rejects.toThrow("ambiguous");
  store.lock();
  uncertain = false;
  vi.restoreAllMocks();
  store.prepareGuestUnlock(tomb);
  await store.unlockWithPin("48291037");
  expect(store.getSnapshot().items.map((item) => item.name)).toContain(
    "Recovered after lock",
  );
  await store.saveItem(createItem("note", "Writable again"));
  store.lock();
});

it("retains a protected guest if the header committed just before lock", async () => {
  const store = newStore();
  await store.createGuest();
  const tomb = store.activeTomb();
  const started = deferred();
  const gate = deferred();
  const actual = kvSeams.kvSetDurable;
  vi.spyOn(kvSeams, "kvSetDurable").mockImplementation(
    async (key, value, check) => {
      await actual(key, value, check);
      if (key === tombFileKey(tomb, HEADER_PATH)) {
        started.release();
        await gate.promise;
      }
    },
  );
  const enrolling = store.enrollPin("48291037");
  const refused = expect(enrolling).rejects.toThrow();
  await started.promise;
  try {
    store.lock();
    gate.release();
    await refused;
    expect(kvGet(tombFileKey(tomb, HEADER_PATH))).not.toBeNull();
    expect(listTombs()).toContain(tomb);
    store.prepareGuestUnlock(tomb);
    await store.unlockWithPin("48291037");
    expect(store.isUnlocked()).toBe(true);
    store.lock();
  } finally {
    gate.release();
    await refused;
  }
});

it("keeps an edit made while guest protection is being committed", async () => {
  const store = newStore();
  await store.createGuest();
  const tomb = store.activeTomb();
  const started = deferred();
  const gate = deferred();
  const actual = kvSeams.kvSetDurable;
  vi.spyOn(kvSeams, "kvSetDurable").mockImplementation(
    async (key, value, check) => {
      if (key === tombFileKey(tomb, HEADER_PATH)) {
        started.release();
        await gate.promise;
      }
      await actual(key, value, check);
    },
  );
  const enrolling = store.enrollPin("48291037");
  await started.promise;
  const saving = store.saveItem(createItem("note", "Edit during protection"));
  try {
    gate.release();
    await enrolling;
    await saving;
    store.lock();
    store.prepareGuestUnlock(tomb);
    await store.unlockWithPin("48291037");
    expect(store.getSnapshot().items.map((item) => item.name)).toContain(
      "Edit during protection",
    );
    store.lock();
  } finally {
    gate.release();
  }
});

it("retries when the registry committed but reported an error", async () => {
  const store = newStore();
  await store.createGuest();
  const tomb = store.activeTomb();
  await store.saveItem(createItem("note", "Still in memory"));
  const actual = vfsSeams.writeRaw;
  let fail = true;
  vi.spyOn(vfsSeams, "writeRaw").mockImplementation(
    async (key, value, vaultKey) => {
      await actual(key, value, vaultKey);
      if (key === TOMBS_REGISTRY_KEY && fail) {
        fail = false;
        throw new Error("storage returned an ambiguous result");
      }
    },
  );
  await expect(store.enrollPin("48291037")).rejects.toThrow("ambiguous");
  expect(listTombs()).toContain(tomb);
  await store.enrollPin("48291037");
  store.lock();
  store.prepareGuestUnlock(tomb);
  await store.unlockWithPin("48291037");
  expect(store.getSnapshot().items.map((item) => item.name)).toContain(
    "Still in memory",
  );
  store.lock();
});
