/** @vitest-environment jsdom */

import { overlapCast } from "@opensesame/os-domain";
import { createItem } from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
import { atRestReady } from "./at-rest/key.js";
import { makeOpfs } from "./duress/wipe/fake-opfs.test-support.js";
import { createForCurrentGuest } from "./guest-connections.js";
import { readStoredGuestContinuation } from "./guest-continuation.js";
import {
  assertGuestVercelNavigationCanResume,
  captureGuestProviderAttempt,
  prepareGuestProviderReturn,
} from "./guest-provider-return.js";
import {
  clearGuestSignOutBarrier,
  completeGuestSignOutCleanup,
  markGuestSignOutBarrier,
} from "./guest-return-barrier.js";
import { advanceGuestReturnEpoch } from "./guest-return-epoch.js";
import { vaultStore } from "./vault/store.js";
import { holdGuestLease } from "./vault/store-unlock-races.fixture.js";
import { vfsFlush } from "./vfs.js";

let root: ReturnType<typeof makeOpfs>;
let locks: ReturnType<typeof webLocksDouble>;

beforeEach(async () => {
  root = makeOpfs();
  locks = webLocksDouble();
  configureHost(
    createTestHost({ locks, originFiles: async () => overlapCast(root) }),
  );
  vaultStore.lock();
  await vaultStore.createGuest();
  await atRestReady();
  const snapshot = vaultStore.getSnapshot.bind(vaultStore);
  vi.spyOn(vaultStore, "getSnapshot").mockImplementation(() => ({
    ...snapshot(),
    durable: true,
  }));
});
afterEach(async () => {
  vaultStore.lock();
  await vfsFlush();
  vi.restoreAllMocks();
  configureHost(createTestHost());
});

it("permits popup authorization when tab storage is unavailable but refuses same-tab navigation", async () => {
  configureHost(
    createTestHost({
      storage: { local: localStorage },
      locks,
      originFiles: async () => overlapCast(root),
    }),
  );
  await expect(
    prepareGuestProviderReturn(
      "vercel",
      "one",
      "https://app.example/connections",
      "one",
    ),
  ).resolves.toBeDefined();
  expect(() => assertGuestVercelNavigationCanResume("one")).toThrow(
    /allow pop-ups|protect this vault/i,
  );
});

it("keeps popup authorization in the open guest without a stale return record", async () => {
  await prepareGuestProviderReturn(
    "vercel",
    "one",
    "https://app.example/connections",
    "one",
  );
  await prepareGuestProviderReturn(
    "vercel",
    "two",
    "https://app.example/connections",
    "two",
  );
  expect(() => assertGuestVercelNavigationCanResume("one")).toThrow(
    /allow pop-ups|protect this vault/i,
  );
  expect(() => assertGuestVercelNavigationCanResume("two")).toThrow(
    /allow pop-ups|protect this vault/i,
  );
  expect(readStoredGuestContinuation()).toBeNull();
});

it("refuses same-tab navigation when Web Locks are unavailable", async () => {
  await prepareGuestProviderReturn(
    "vercel",
    "one",
    "https://app.example/connections",
    "one",
  );
  configureHost(
    createTestHost({
      locks: undefined,
      originFiles: async () => overlapCast(root),
    }),
  );
  expect(() => assertGuestVercelNavigationCanResume("one")).toThrow(
    /allow pop-ups|protect this vault/i,
  );
});

it("prevents a GitHub redirect from discarding an unprotected guest vault", async () => {
  await vaultStore.saveItem(createItem("note", "Keep this guest item"));
  await expect(
    prepareGuestProviderReturn(
      "github",
      "state",
      "https://app.example/connections",
    ),
  ).rejects.toThrow(/protect this vault/i);
  expect(vaultStore.isUnlocked()).toBe(true);
  expect(vaultStore.getSnapshot().items.map((item) => item.name)).toContain(
    "Keep this guest item",
  );
});

it("permits the provider path after protection and preserves saved items on lock and reopen", async () => {
  await vaultStore.saveItem(createItem("note", "Saved before connecting"));
  const tomb = vaultStore.activeTomb();
  // This fixture has no physical credential-inventory port, so promote through
  // the memory backend. Browser-backed protection is covered separately.
  configureHost(createTestHost({ locks }));
  await vaultStore.enrollPin("48291037");
  await expect(
    prepareGuestProviderReturn(
      "github",
      "state",
      "https://app.example/connections",
    ),
  ).resolves.toBe("https://app.example/connections");
  vaultStore.lock();
  await vfsFlush();
  vaultStore.prepareGuestUnlock(tomb);
  await vaultStore.unlockWithPin("48291037");
  expect(vaultStore.getSnapshot().items.map((item) => item.name)).toContain(
    "Saved before connecting",
  );
});

it("refuses provider windows when hiding the page would lock the guest", () => {
  const snapshot = vaultStore.getSnapshot();
  vi.spyOn(vaultStore, "getSnapshot").mockReturnValue({
    ...snapshot,
    prefs: { ...snapshot.prefs, lockOnHide: true },
  });
  expect(() => captureGuestProviderAttempt()).toThrow(/lock when hidden/i);
});

it("refuses an authorization response after its guest has locked", () => {
  const check = captureGuestProviderAttempt();
  vaultStore.lock();
  expect(check).toThrow(/guest session ended/i);
});

it("rejects both new and pending provider attempts for a guest invalidated in another tab", async () => {
  const previousAttempt = captureGuestProviderAttempt();
  advanceGuestReturnEpoch();
  expect(previousAttempt).toThrow(/guest session ended/i);
  expect(() => captureGuestProviderAttempt()).toThrow(/guest session ended/i);
  const create = vi.fn(async () => ({ connectionId: "stale" }));
  await expect(createForCurrentGuest(create)).rejects.toThrow(
    /guest session ended/i,
  );
  expect(create).not.toHaveBeenCalled();
});

it("does not publish a guest that was opening when another tab signed out", async () => {
  vaultStore.lock();
  await vfsFlush();
  const held = holdGuestLease();
  const opening = vaultStore.createGuest();
  const rejected = expect(opening).rejects.toThrow(/guest session ended/i);
  await held.started;
  try {
    advanceGuestReturnEpoch();
    held.release();
    await rejected;
    expect(vaultStore.isUnlocked()).toBe(false);
  } finally {
    held.release();
  }
});

it("refuses a provider return while a browser sign-out is incomplete", async () => {
  markGuestSignOutBarrier(true);
  try {
    await expect(
      prepareGuestProviderReturn(
        "vercel",
        "one",
        "https://app.example/connections",
        "one",
      ),
    ).rejects.toThrow(/signing out/i);
  } finally {
    completeGuestSignOutCleanup();
    clearGuestSignOutBarrier();
  }
});
