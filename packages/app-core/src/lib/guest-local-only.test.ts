/** @vitest-environment jsdom */
import { createItem } from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost, host } from "../host.js";
import { createTestHost } from "../test-host.js";
import { captureAmbientGuestFence } from "./ambient-auth/guest-fence.js";
import { forgetAtRestKeyForTest } from "./at-rest/key.js";
import { forgetHeldWebStorageForTest } from "./at-rest/web-storage.js";
import { identityPlaneRequest } from "./device-identity.js";
import { continueAsGuest, guestAuthDependencies } from "./guest-auth.js";
import { createForCurrentGuest } from "./guest-connections.js";
import { captureGuestProviderAttempt } from "./guest-provider-return.js";
import { advanceGuestReturnEpoch } from "./guest-return-epoch.js";
import { isLocalOnlyGuest } from "./guest-session-context.js";
import { clearSession, identitySeams, settleRevokes } from "./identity.js";
import { kvForgetAll } from "./kv.js";
import { listNotices } from "./notices.js";
import { vaultStore } from "./vault/store.js";
import { vfsFlush } from "./vfs.js";

const original = { ...guestAuthDependencies };
beforeEach(async () => {
  configureHost(createTestHost());
  vaultStore.lock();
  await vfsFlush();
  kvForgetAll();
  localStorage.clear();
  sessionStorage.clear();
  vaultStore.loadActiveProjectScope();
  Object.assign(guestAuthDependencies, {
    currentSession: () => null,
    hasHostSession: () => false,
    loadFederationSession: () => null,
    settleRevokes: async () => {},
    inspectIdentityCookie: async () => "unknown",
    isRemoteIdentityConfigured: () => true,
  });
});
afterEach(async () => {
  clearSession();
  vaultStore.lock();
  await vfsFlush();
  Object.assign(guestAuthDependencies, original);
  vi.restoreAllMocks();
  forgetAtRestKeyForTest();
  forgetHeldWebStorageForTest();
  configureHost(createTestHost());
});

it("opens a restricted vault offline when no remote Identity service is configured", async () => {
  const mint = vi.fn();
  guestAuthDependencies.connectProvisional = mint;
  guestAuthDependencies.isRemoteIdentityConfigured = () => false;
  forgetAtRestKeyForTest();
  configureHost(createTestHost({ atRestKeys: undefined }));
  await continueAsGuest();
  expect(vaultStore.isUnlocked()).toBe(true);
  expect(isLocalOnlyGuest()).toBe(true);
  expect(mint).not.toHaveBeenCalled();
  expect(listNotices().some((notice) => notice.id === "guest.local-only")).toBe(
    true,
  );
  expect(() => captureGuestProviderAttempt()).toThrow(/local only/i);
  const create = vi.fn(async () => ({ connectionId: "old-service" }));
  await expect(createForCurrentGuest(create)).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
});

it("preserves a protected guest while another guest uses the device offline", async () => {
  guestAuthDependencies.isRemoteIdentityConfigured = () => false;
  const fetcher = vi.fn(async () => {
    throw new Error("offline");
  });
  vi.stubGlobal("fetch", fetcher);
  await continueAsGuest();
  const protectedTomb = vaultStore.activeTomb();
  await vaultStore.saveItem(createItem("note", "Protected offline item"));
  await vaultStore.enrollPin("48291037");
  vaultStore.lock();
  await vfsFlush();

  await continueAsGuest();
  expect(vaultStore.activeTomb()).not.toBe(protectedTomb);
  await vaultStore.saveItem(createItem("note", "Separate offline item"));
  vaultStore.lock();
  await vfsFlush();

  vaultStore.prepareGuestUnlock(protectedTomb);
  await vaultStore.unlockWithPin("48291037");
  expect(vaultStore.getSnapshot().items.map((item) => item.name)).toEqual([
    "Protected offline item",
  ]);
  expect(fetcher).not.toHaveBeenCalled();
});

it("allows a local vault when session storage is blocked", async () => {
  guestAuthDependencies.isRemoteIdentityConfigured = () => false;
  const originalHost = host();
  configureHost({
    ...originalHost,
    storage: {
      local: originalHost.storage?.local,
      get session(): never {
        throw new DOMException("blocked", "SecurityError");
      },
    },
  });
  await continueAsGuest();
  expect(vaultStore.isUnlocked()).toBe(true);
  expect(isLocalOnlyGuest()).toBe(true);
});

it("refuses guest entry when remote sign-out storage cannot be inspected", async () => {
  const originalHost = host();
  configureHost({
    ...originalHost,
    storage: { ...originalHost.storage, local: undefined },
  });
  guestAuthDependencies.settleRevokes = settleRevokes;
  await expect(continueAsGuest()).rejects.toThrow(/cannot verify/i);
  expect(vaultStore.isUnlocked()).toBe(false);
});

it("keeps a guest local when the device encryption key is not durable", async () => {
  forgetAtRestKeyForTest();
  configureHost(createTestHost({ atRestKeys: undefined }));
  guestAuthDependencies.inspectIdentityCookie = async () => "absent";
  await continueAsGuest();
  expect(vaultStore.isUnlocked()).toBe(true);
  expect(isLocalOnlyGuest()).toBe(true);
});

it("does not contact a configured Identity service from a local-only guest", async () => {
  const { loadSettings, saveSettings } = await import("./settings.js");
  saveSettings({ ...loadSettings(), identityApi: "https://identity.example" });
  forgetAtRestKeyForTest();
  configureHost(createTestHost({ atRestKeys: undefined }));
  guestAuthDependencies.inspectIdentityCookie = async () => "absent";
  await continueAsGuest();
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(identityPlaneRequest("/v1/principals/me")).rejects.toThrow(
    /local only/i,
  );
  expect(fetcher).not.toHaveBeenCalled();
});

it("requires sign-out when a previous remote session is confirmed", async () => {
  guestAuthDependencies.inspectIdentityCookie = async () => "present";
  await expect(continueAsGuest()).rejects.toThrow(/sign out/i);
  expect(vaultStore.isUnlocked()).toBe(false);
});

it("requires sign-out when the browser still has a Host grant", async () => {
  guestAuthDependencies.hasHostSession = () => true;
  await expect(continueAsGuest()).rejects.toThrow(/sign out/i);
  expect(vaultStore.isUnlocked()).toBe(false);
});

it("requires sign-out for a hidden stale Identity session", async () => {
  const issuer = "https://identity.example";
  configureHost(createTestHost({ env: { VITE_IDENTITY_API: issuer } }));
  identitySeams.restoreSession({
    issuerOrigin: issuer,
    principalId: "previous",
    accessToken: "previous-token",
  });
  advanceGuestReturnEpoch();
  await expect(continueAsGuest()).rejects.toThrow(/sign out/i);
  expect(vaultStore.isUnlocked()).toBe(false);
});

it("cancels automatic sign-in that began before the local-only guest opened", async () => {
  const check = captureAmbientGuestFence();
  guestAuthDependencies.isRemoteIdentityConfigured = () => false;
  await continueAsGuest();
  expect(() => check()).toThrow();
});
