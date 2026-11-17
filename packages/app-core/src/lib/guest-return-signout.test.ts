/** @vitest-environment jsdom */
import { overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeEach, expect, it } from "vitest";
import { configureHost, host } from "../host.js";
import { sessionStore } from "../ports.js";
import { createTestHost } from "../test-host.js";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
import { clearAuthOutcome, readAuthOutcome } from "./auth-outcome.js";
import { makeOpfs } from "./duress/wipe/fake-opfs.test-support.js";
import { federationSeams } from "./federation.js";
import { continueAsGuest } from "./guest-auth.js";
import { openGuestVault } from "./guest-auth-entry.js";
import {
  type GuestContinuation,
  readStoredGuestContinuation,
  saveGuestContinuation,
} from "./guest-continuation.js";
import { consumeGuestReturn, issueGuestReturn } from "./guest-return-record.js";
import {
  guestReturnSignOutSnapshot,
  settleGuestReturnSignOut,
} from "./guest-return-signout.js";
import { newGuestVaultId } from "./guest-vault-id.js";
import { kvForgetAll } from "./kv.js";
import { readGuestSessionPerson } from "./local-guest.js";
import { dismissNotice } from "./notices.js";
import { signOut, switchAccount } from "./session-exit.js";
import { vaultStore } from "./vault/store.js";
import { acquireExclusiveGuestLease } from "./vault/vault-shared-locks.js";
import { vfsFlush } from "./vfs.js";

let value: GuestContinuation;
beforeEach(async () => {
  const root = makeOpfs();
  configureHost(
    createTestHost({
      locks: webLocksDouble(),
      originFiles: async () => overlapCast(root),
    }),
  );
  vaultStore.lock();
  await vfsFlush();
  kvForgetAll();
  sessionStore().removeItem("opensesame.guest.pending-return-signout.v1");
  sessionStore().removeItem("opensesame.guest.provider-return.v1");
  value = {
    kind: "vercel",
    token: crypto.randomUUID(),
    connectionId: "connection",
    tomb: newGuestVaultId(),
    person: { id: "old-guest", name: "Guest" },
    origin: "https://app.example",
    pathname: "/connections",
    deadline: Date.now() + 60_000,
    identity: null,
  };
  await issueGuestReturn(value, () => {});
  saveGuestContinuation(value);
});
afterEach(async () => {
  await settleGuestReturnSignOut().catch(() => {});
  await vfsFlush();
  sessionStore().removeItem("opensesame.guest.pending-return-signout.v1");
  sessionStore().removeItem("opensesame.guest.provider-return.v1");
  kvForgetAll();
  configureHost(createTestHost());
});

it("revokes a copied callback even after its original URL was cleared", async () => {
  signOut();
  await settleGuestReturnSignOut();
  kvForgetAll();
  await expect(consumeGuestReturn(value, () => {})).rejects.toThrow(/expired/i);
});

it("keeps sign-out pending until another guest tab releases its lease", async () => {
  const release = await acquireExclusiveGuestLease(value.tomb, true);
  signOut();
  await expect(settleGuestReturnSignOut()).rejects.toThrow(
    /finish signing out/i,
  );
  expect(guestReturnSignOutSnapshot()?.error).toMatch(/other tabs/i);
  await release();
  await settleGuestReturnSignOut();
  expect(guestReturnSignOutSnapshot()).toBeNull();
  await expect(consumeGuestReturn(value, () => {})).rejects.toThrow(/expired/i);
});

it("keeps the switch-account prompt after the pending return is revoked", async () => {
  switchAccount();
  await settleGuestReturnSignOut();
  expect(readAuthOutcome()).toMatchObject({
    kind: "signed_out",
    switching: true,
  });
});

it("does not report sign-out if a federation session is present at completion", async () => {
  clearAuthOutcome();
  const original = federationSeams.loadSession;
  try {
    signOut();
    federationSeams.loadSession = () => ({
      issuer: "https://identity.example",
      upstreamId: "example",
      idToken: "header.payload.signature",
      pairwiseSub: "person",
      audience: "origin:https://app.example",
      jwksUri: "https://identity.example/jwks",
      expiresAt: Date.now() + 60_000,
    });
    await settleGuestReturnSignOut();
    expect(readAuthOutcome()).toBeNull();
  } finally {
    federationSeams.loadSession = original;
  }
});

it("allows memory-only entry when the session-storage getter is blocked", async () => {
  const original = host();
  const storage = {
    get session(): never {
      throw new DOMException("blocked", "SecurityError");
    },
  };
  configureHost(createTestHost({ storage }));
  try {
    await expect(settleGuestReturnSignOut()).resolves.toBeUndefined();
  } finally {
    configureHost(original);
  }
});

it("retains the callback if staging sign-out fails before the guest locks", async () => {
  await vaultStore.createGuest();
  const person = readGuestSessionPerson();
  if (!person) throw new Error("Missing guest person");
  value = { ...value, tomb: vaultStore.activeTomb(), person };
  await issueGuestReturn(value, () => {});
  saveGuestContinuation(value);
  const original = host();
  const real = original.storage?.session;
  if (!real) throw new Error("Missing test session storage");
  const denied = {
    get length() {
      return real.length;
    },
    key: (index: number) => real.key(index),
    getItem: (key: string) => real.getItem(key),
    setItem: (key: string, text: string) => {
      if (key === "opensesame.guest.pending-return-signout.v1")
        throw new Error("quota");
      real.setItem(key, text);
    },
    removeItem: (key: string) => real.removeItem(key),
  };
  configureHost({
    ...original,
    storage: { ...original.storage, session: denied },
  });
  try {
    signOut();
    await expect(settleGuestReturnSignOut()).rejects.toThrow(
      /finish signing out/i,
    );
    expect(readStoredGuestContinuation()?.token).toBe(value.token);
  } finally {
    configureHost(original);
  }
  await vfsFlush();
  await settleGuestReturnSignOut();
  expect(readStoredGuestContinuation()).toBeNull();
});

it("retains and revokes the return after a transient inspection failure", async () => {
  await vaultStore.createGuest();
  const person = readGuestSessionPerson();
  if (!person) throw new Error("Missing guest person");
  value = { ...value, tomb: vaultStore.activeTomb(), person };
  await issueGuestReturn(value, () => {});
  saveGuestContinuation(value);
  const original = host();
  const real = original.storage?.session;
  if (!real) throw new Error("Missing test session storage");
  let failOnce = true;
  const flaky = {
    get length() {
      return real.length;
    },
    key: (index: number) => real.key(index),
    getItem: (key: string) => {
      if (key === "opensesame.guest.provider-return.v1" && failOnce) {
        failOnce = false;
        throw new DOMException("blocked", "SecurityError");
      }
      return real.getItem(key);
    },
    setItem: (key: string, text: string) => real.setItem(key, text),
    removeItem: (key: string) => real.removeItem(key),
  };
  configureHost({
    ...original,
    storage: { ...original.storage, session: flaky },
  });
  try {
    signOut();
    expect(vaultStore.isUnlocked()).toBe(false);
    expect(readStoredGuestContinuation()?.token).toBe(value.token);
    await expect(settleGuestReturnSignOut()).rejects.toThrow(
      /sign(?:ing)?[ -]out/i,
    );
  } finally {
    configureHost(original);
  }
  await vfsFlush();
  signOut();
  await settleGuestReturnSignOut();
  await expect(consumeGuestReturn(value, () => {})).rejects.toThrow(/expired/i);
});

it("does not report success when another part of sign-out fails", async () => {
  const original = host();
  const real = original.storage?.session;
  if (!real) throw new Error("Missing test session storage");
  const flaky = {
    get length() {
      return real.length;
    },
    key: (index: number) => real.key(index),
    getItem: (key: string) => real.getItem(key),
    setItem: (key: string, text: string) => real.setItem(key, text),
    removeItem: (key: string) => {
      if (key === "opensesame:federation:pkce") throw new Error("blocked");
      real.removeItem(key);
    },
  };
  configureHost({
    ...original,
    storage: { ...original.storage, session: flaky },
  });
  try {
    signOut();
    await expect(settleGuestReturnSignOut()).rejects.toThrow(
      /sign(?:ing)?[ -]out/i,
    );
    expect(guestReturnSignOutSnapshot()?.complete).not.toBe(true);
    expect(readAuthOutcome()).toBeNull();
  } finally {
    configureHost(original);
  }
  signOut();
  await settleGuestReturnSignOut();
  expect(readAuthOutcome()).toMatchObject({ kind: "signed_out" });
  await expect(consumeGuestReturn(value, () => {})).rejects.toThrow(/expired/i);
});

it("keeps failed cleanup fenced after its notice is dismissed", async () => {
  const release = await acquireExclusiveGuestLease(value.tomb, true);
  const original = host();
  const real = original.storage?.session;
  if (!real) throw new Error("Missing test session storage");
  const blocked = {
    get length() {
      return real.length;
    },
    key: (index: number) => real.key(index),
    getItem: (key: string) => real.getItem(key),
    setItem: (key: string, text: string) => real.setItem(key, text),
    removeItem: (key: string) => {
      if (key === "opensesame:federation:pkce") throw new Error("blocked");
      real.removeItem(key);
    },
  };
  configureHost({
    ...original,
    storage: { ...original.storage, session: blocked },
  });
  try {
    signOut();
    dismissNotice("session.signout-incomplete");
    await release();
    await expect(settleGuestReturnSignOut()).rejects.toThrow(
      /sign(?:ing)?[ -]out/i,
    );
    expect(guestReturnSignOutSnapshot()?.complete).not.toBe(true);
  } finally {
    configureHost(original);
  }
  signOut();
  await settleGuestReturnSignOut();
  await expect(consumeGuestReturn(value, () => {})).rejects.toThrow(/expired/i);
});

it("requires sign-out before a fresh guest can replace a pending return", async () => {
  await expect(continueAsGuest()).rejects.toThrow(
    /sign out.*existing account/i,
  );
  expect(readStoredGuestContinuation()?.token).toBe(value.token);
  signOut();
  await settleGuestReturnSignOut();
  await expect(consumeGuestReturn(value, () => {})).rejects.toThrow(/expired/i);
});

it("requires sign-out before an authenticated landing opens another guest", async () => {
  await expect(openGuestVault("resume")).rejects.toThrow(
    /sign out.*existing account/i,
  );
  expect(readStoredGuestContinuation()?.token).toBe(value.token);
  signOut();
  await settleGuestReturnSignOut();
  await expect(consumeGuestReturn(value, () => {})).rejects.toThrow(/expired/i);
});
