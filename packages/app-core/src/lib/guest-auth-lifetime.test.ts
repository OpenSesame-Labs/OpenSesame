/** @vitest-environment jsdom */
import { overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { sessionStore } from "../ports.js";
import { createTestHost } from "../test-host.js";
import { resolveIdentityBase } from "./device-identity.js";
import {
  continueAsGuest,
  guestAuthDependencies,
  linkGuestAccount,
  openVaultAfterSignIn,
} from "./guest-auth.js";
import {
  claimGuestConnection,
  guestClaimedConnections,
} from "./guest-connections.js";
import { advanceGuestReturnEpoch } from "./guest-return-epoch.js";
import * as identityCookieTransport from "./identity-cookie-transport.js";
import { kvForgetAll } from "./kv.js";
import { readGuestSessionPerson } from "./local-guest.js";
import { clearNotices, listNotices } from "./notices.js";
import { signOut } from "./session-exit.js";
import { vaultStore } from "./vault/store.js";
import {
  deferred,
  holdGuestLease,
} from "./vault/store-unlock-races.fixture.js";
import { vfsFlush } from "./vfs.js";

const original = { ...guestAuthDependencies };
beforeEach(async () => {
  configureHost(createTestHost());
  vaultStore.lock();
  await vfsFlush();
  kvForgetAll();
  vaultStore.loadActiveProjectScope();
  clearNotices();
  Object.assign(guestAuthDependencies, {
    currentSession: () => null,
    loadFederationSession: () => null,
    settleRevokes: async () => {},
    inspectIdentityCookie: async () => "absent",
    isRemoteIdentityConfigured: () => true,
  });
});

it("does not reuse a previous guest's connections after sign-out and a new sign-in", async () => {
  await vaultStore.createGuest();
  const previous = readGuestSessionPerson();
  expect(previous).not.toBeNull();
  claimGuestConnection("private-connector");
  vaultStore.lock();
  // A reload can restore the old tab's continuation metadata while locked.
  sessionStore().setItem(
    "opensesame.guest.isolated-person.v1",
    JSON.stringify(previous),
  );
  expect(readGuestSessionPerson()?.id).toBe(previous?.id);
  signOut();
  await openVaultAfterSignIn();
  expect(readGuestSessionPerson()?.id).not.toBe(previous?.id);
  expect(guestClaimedConnections().has("private-connector")).toBe(false);
});
afterEach(async () => {
  vaultStore.lock();
  await vaultStore.flushPendingWrites();
  Object.assign(guestAuthDependencies, original);
  vi.restoreAllMocks();
});

it("does not open a guest after locking while its vault lease is pending", async () => {
  const held = holdGuestLease();
  const opening = continueAsGuest();
  const refused = expect(opening).rejects.toThrow();
  await held.started;
  try {
    vaultStore.lock();
    held.release();
    await refused;
    expect(vaultStore.isUnlocked()).toBe(false);
  } finally {
    held.release();
  }
});

it("does not hand a previous guest's delayed identity to the next guest", async () => {
  const started = deferred();
  const gate = deferred();
  let calls = 0;
  guestAuthDependencies.connectProvisional = vi.fn(async (options) => {
    if (++calls === 1) {
      started.release();
      await gate.promise;
    }
    options?.check?.();
    return {
      principalId: `principal-${calls}`,
      accessToken: "test",
      issuerOrigin: "https://identity.example",
    };
  });
  const first = continueAsGuest();
  const refused = expect(first).rejects.toThrow();
  await started.promise;
  const firstTomb = vaultStore.activeTomb();
  vaultStore.lock();
  await continueAsGuest();
  const secondTomb = vaultStore.activeTomb();
  gate.release();
  await refused;
  expect(secondTomb).not.toBe(firstTomb);
  expect(vaultStore.isUnlocked()).toBe(true);
  expect(vaultStore.activeTomb()).toBe(secondTomb);
  expect(calls).toBe(2);
});

it("does not publish a guest identity after another tab signs out", async () => {
  const started = deferred();
  const gate = deferred();
  guestAuthDependencies.connectProvisional = vi.fn(async (options) => {
    started.release();
    await gate.promise;
    options?.check?.();
    return {
      principalId: "late-principal",
      accessToken: "test",
      issuerOrigin: "https://identity.example",
    };
  });
  const opening = continueAsGuest();
  const refused = expect(opening).rejects.toThrow(/guest session ended/i);
  await started.promise;
  try {
    advanceGuestReturnEpoch();
    gate.release();
    await refused;
    expect(vaultStore.isUnlocked()).toBe(false);
  } finally {
    gate.release();
  }
});

it("does not rebind a guest to an identity after another tab signs out", async () => {
  await continueAsGuest();
  const identity = {
    principalId: "original-principal",
    accessToken: "original-token",
    issuerOrigin:
      identityCookieTransport.identityOriginFor(resolveIdentityBase),
  };
  guestAuthDependencies.currentSession = () => identity;
  const started = deferred();
  const gate = deferred();
  guestAuthDependencies.identityJson = async <T>() => {
    started.release();
    await gate.promise;
    const result = { principalId: "other-principal", accessToken: "new-token" };
    return overlapCast<typeof result, T>(result);
  };
  const rebind = vi.fn(async () => {});
  guestAuthDependencies.rebindSession = rebind;
  const revoke = vi
    .spyOn(identityCookieTransport, "revokeRequest")
    .mockResolvedValue(new Response(null, { status: 204 }));
  const linking = linkGuestAccount("test-assertion");
  const refused = expect(linking).rejects.toThrow();
  await started.promise;
  try {
    advanceGuestReturnEpoch();
    gate.release();
    await refused;
    expect(rebind).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith("new-token", "omit");
  } finally {
    gate.release();
  }
});

it("requires verified sign-out when a previous remote sign-in cannot be inspected", async () => {
  guestAuthDependencies.inspectIdentityCookie = async () => "unknown";
  await expect(continueAsGuest()).rejects.toThrow(/Cannot verify/);
  expect(vaultStore.isUnlocked()).toBe(false);
  expect(listNotices().some((notice) => notice.id === "guest.local-only")).toBe(
    false,
  );
});
