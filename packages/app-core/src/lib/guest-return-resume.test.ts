/** @vitest-environment jsdom */
import { overlapCast } from "@opensesame/os-domain";
import { createItem } from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
import { makeOpfs } from "./duress/wipe/fake-opfs.test-support.js";
import { resumeGuestSessionDefault } from "./guest-auth-entry.js";
import {
  type GuestContinuation,
  readStoredGuestContinuation,
  saveGuestContinuation,
} from "./guest-continuation.js";
import {
  consumeGuestReturn,
  issueGuestReturn,
  revokeGuestReturns,
} from "./guest-return-record.js";
import { newGuestVaultId } from "./guest-vault-id.js";
import { clearSession, currentSession } from "./identity.js";
import {
  clearCookieBinding,
  saveCookieBinding,
} from "./identity-cookie-binding.js";
import { kvForgetAll, kvGet, kvSetDurable } from "./kv.js";
import {
  activateIsolatedGuestPerson,
  clearIsolatedGuestPerson,
  readGuestSessionPerson,
} from "./local-guest.js";
import { clearNotices, listNotices } from "./notices.js";
import { loadSettings, saveSettings } from "./settings.js";
import { vaultStore } from "./vault/store.js";
import { acquireExclusiveGuestLease } from "./vault/vault-shared-locks.js";
import { HEADER_PATH, tombFileKey, vfsFlush } from "./vfs.js";

let value: GuestContinuation;

beforeEach(async () => {
  vaultStore.lock();
  await vfsFlush();
  localStorage.clear();
  sessionStorage.clear();
  kvForgetAll();
  const root = makeOpfs();
  configureHost(
    createTestHost({
      locks: webLocksDouble(),
      originFiles: async () => overlapCast(root),
    }),
  );
  value = {
    kind: "vercel",
    token: crypto.randomUUID(),
    connectionId: "connection",
    tomb: newGuestVaultId(),
    person: { id: `local_${crypto.randomUUID()}`, name: "guest-1" },
    origin: window.location.origin,
    pathname: "/connections",
    deadline: Date.now() + 60_000,
    identity: null,
  };
  window.history.replaceState(
    {},
    "",
    `/connections?connection=connection&guest_return=${value.token}`,
  );
  activateIsolatedGuestPerson(value.person);
  await issueGuestReturn(value, () => {});
  saveGuestContinuation(value);
});

afterEach(async () => {
  vaultStore.lock();
  await vfsFlush();
  clearIsolatedGuestPerson();
  localStorage.clear();
  sessionStorage.clear();
  kvForgetAll();
  clearSession();
  clearCookieBinding();
  clearNotices();
  vi.unstubAllGlobals();
  configureHost(createTestHost());
});

it("opens the original actor once after a valid provider return", async () => {
  await resumeGuestSessionDefault();
  expect(vaultStore.activeTomb()).toBe(value.tomb);
  expect(readGuestSessionPerson()).toEqual(value.person);
  expect(readStoredGuestContinuation()).toBeNull();
  await expect(consumeGuestReturn(value, () => {})).rejects.toThrow(/expired/i);
  await vaultStore.saveItem(createItem("note", "Created after return"));
  expect(vaultStore.getSnapshot().items.map((item) => item.name)).toContain(
    "Created after return",
  );
});

it("does not reopen a return revoked before the user continued", async () => {
  await revokeGuestReturns(value.tomb);
  await expect(resumeGuestSessionDefault()).rejects.toThrow(/expired/i);
  expect(vaultStore.isUnlocked()).toBe(false);
  expect(readStoredGuestContinuation()?.token).toBe(value.token);
});

it("does not reopen a return for a different tab actor", async () => {
  activateIsolatedGuestPerson({
    id: `local_${crypto.randomUUID()}`,
    name: "guest-2",
  });
  await expect(resumeGuestSessionDefault()).rejects.toThrow(/expired/i);
  expect(vaultStore.isUnlocked()).toBe(false);
  await expect(consumeGuestReturn(value, () => {})).resolves.toBeUndefined();
});

it("waits for the original guest lease to be released before continuing", async () => {
  const release = await acquireExclusiveGuestLease(value.tomb, true);
  try {
    await expect(resumeGuestSessionDefault()).rejects.toThrow(/another tab/i);
    expect(vaultStore.isUnlocked()).toBe(false);
    expect(readStoredGuestContinuation()?.token).toBe(value.token);
  } finally {
    await release();
  }
  await expect(resumeGuestSessionDefault()).resolves.toBeUndefined();
  expect(vaultStore.activeTomb()).toBe(value.tomb);
});

it("does not shadow an existing protected guest header", async () => {
  const key = tombFileKey(value.tomb, HEADER_PATH);
  await kvSetDurable(key, "previous-header");
  await expect(resumeGuestSessionDefault()).rejects.toThrow(/already exists/i);
  expect(vaultStore.isUnlocked()).toBe(false);
  expect(kvGet(key)).toBe("previous-header");
  await expect(consumeGuestReturn(value, () => {})).resolves.toBeUndefined();
});

it("rejects a modified continuation even when its callback matches", async () => {
  const altered = { ...value, token: crypto.randomUUID() };
  saveGuestContinuation(altered);
  window.history.replaceState(
    {},
    "",
    `/connections?connection=connection&guest_return=${altered.token}`,
  );
  await expect(resumeGuestSessionDefault()).rejects.toThrow(/expired/i);
  expect(vaultStore.isUnlocked()).toBe(false);
  await expect(consumeGuestReturn(value, () => {})).resolves.toBeUndefined();
});

it.each([true, false])(
  "restores only the exact bound identity on provider return (match=%s)",
  async (matches) => {
    const issuerOrigin = "https://identity.example.test";
    const principalId = "principal-1";
    const sessionId = "session-1";
    saveSettings({ ...loadSettings(), identityApi: issuerOrigin });
    expect(
      saveCookieBinding({
        issuerOrigin,
        principalId,
        sessionId,
        proof: "1".repeat(64),
      }),
    ).toBe(true);
    value = {
      ...value,
      identity: { issuerOrigin, principalId, sessionId },
      identityExpected: true,
    };
    await issueGuestReturn(value, () => {});
    saveGuestContinuation(value);
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ id: matches ? principalId : "different-principal" }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-opensesame-cookie-bound": "1",
            },
          },
        ),
    );
    vi.stubGlobal("fetch", fetcher);
    await resumeGuestSessionDefault();
    expect(vaultStore.activeTomb()).toBe(value.tomb);
    expect(fetcher).toHaveBeenCalledOnce();
    if (matches) {
      expect(currentSession()).toMatchObject({
        principalId,
        issuerOrigin,
        cookieOnly: true,
      });
    } else {
      expect(currentSession()).toBeNull();
      expect(
        listNotices().some(
          (notice) => notice.id === "guest.identity-sign-in-again",
        ),
      ).toBe(true);
    }
  },
);
