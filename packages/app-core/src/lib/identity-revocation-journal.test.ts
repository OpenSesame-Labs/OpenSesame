/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { configureHost, host } from "../host.js";
import { createTestHost } from "../test-host.js";
import { sealLegacyWebStorage } from "./at-rest/web-storage.js";
import {
  clearGuestSignOutBarrier,
  completeGuestSignOutCleanup,
  guestSignOutBarrierActive,
} from "./guest-return-barrier.js";
import { advanceGuestReturnEpoch } from "./guest-return-epoch.js";
import {
  clearSession,
  currentSession,
  endSession,
  identityFetch,
  identitySeams,
  settleRevokes,
} from "./identity.js";
import {
  clearCookieBinding,
  readCookieBinding,
  saveCookieBinding,
} from "./identity-cookie-binding.js";
import { IDENTITY_COOKIE_BINDING_KEY } from "./identity-cookie-binding-key.js";
import {
  forgetBoundRevocation,
  listBoundRevocations,
  stageBoundRevocation,
} from "./identity-revocation-journal.js";
import { IDENTITY_REVOCATION_PREFIX } from "./identity-revocation-key.js";

afterEach(() => {
  configureHost(createTestHost());
  completeGuestSignOutCleanup();
  clearGuestSignOutBarrier();
  clearCookieBinding();
  clearSession();
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

it("preserves an unreadable pending revocation and blocks a fresh guest", () => {
  localStorage.clear();
  const key = `${IDENTITY_REVOCATION_PREFIX}corrupt`;
  localStorage.setItem(key, "unsealed");
  sealLegacyWebStorage("local");
  expect(localStorage.getItem(key)).toBe("unsealed");
  expect(guestSignOutBarrierActive()).toBe(true);
  expect(() => listBoundRevocations()).toThrow(/could not be verified/i);
});

it("retains the original proof and blocks restoration when the journal cannot be saved", async () => {
  const issuer = "https://identity.example";
  configureHost(createTestHost({ env: { VITE_IDENTITY_API: issuer } }));
  const binding = {
    issuerOrigin: issuer,
    principalId: "previous",
    sessionId: "ps_previous",
    proof: "c".repeat(64),
  };
  expect(saveCookieBinding(binding)).toBe(true);
  const original = host();
  configureHost({
    ...original,
    storage: { ...original.storage, local: undefined },
  });
  expect(() => endSession()).toThrow(/storage is unavailable/i);
  expect(readCookieBinding(issuer)).toEqual(binding);
  await expect(identitySeams.resumeSession()).rejects.toThrow(
    /check browser storage/i,
  );
});

it("cannot restore a different tab's cookie while a sign-out is pending", async () => {
  const issuer = "https://identity.example";
  configureHost(createTestHost({ env: { VITE_IDENTITY_API: issuer } }));
  const binding = {
    issuerOrigin: issuer,
    principalId: "previous",
    sessionId: "ps_previous",
    proof: "d".repeat(64),
  };
  saveCookieBinding(binding);
  stageBoundRevocation(binding, false);
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(identitySeams.resumeSession()).rejects.toThrow(
    /finish signing out/i,
  );
  expect(fetcher).not.toHaveBeenCalled();
});

it("does not report sign-out when the only saved proof is unreadable", async () => {
  const issuer = "https://identity.example";
  configureHost(createTestHost({ env: { VITE_IDENTITY_API: issuer } }));
  clearCookieBinding();
  sessionStorage.setItem(IDENTITY_COOKIE_BINDING_KEY, "osr2.invalid");
  sealLegacyWebStorage("session");
  expect(() => endSession({ orphan: true })).toThrow(/could not be verified/i);
  expect(sessionStorage.getItem(IDENTITY_COOKIE_BINDING_KEY)).toBe(
    "osr2.invalid",
  );
  expect(guestSignOutBarrierActive()).toBe(true);
  await expect(identitySeams.resumeSession()).rejects.toThrow(
    /finish signing out/i,
  );
});

it("does not report sign-out when the session storage port is unavailable", () => {
  const issuer = "https://identity.example";
  configureHost(createTestHost({ env: { VITE_IDENTITY_API: issuer } }));
  saveCookieBinding({
    issuerOrigin: issuer,
    principalId: "previous",
    sessionId: "ps_previous",
    proof: "b".repeat(64),
  });
  const saved = sessionStorage.getItem(IDENTITY_COOKIE_BINDING_KEY);
  const original = host();
  configureHost({
    ...original,
    storage: { ...original.storage, session: undefined },
  });
  expect(() => endSession({ orphan: true })).toThrow(/could not be verified/i);
  expect(sessionStorage.getItem(IDENTITY_COOKIE_BINDING_KEY)).toBe(saved);
});

it("retires an already-open identity and refuses its requests while another tab signs out", async () => {
  const issuer = "https://identity.example";
  configureHost(createTestHost({ env: { VITE_IDENTITY_API: issuer } }));
  identitySeams.restoreSession({
    issuerOrigin: issuer,
    principalId: "old-principal",
    accessToken: "previous-token",
  });
  stageBoundRevocation(
    {
      issuerOrigin: issuer,
      principalId: "old-principal",
      sessionId: "ps_previous",
      proof: "e".repeat(64),
    },
    false,
  );
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  expect(currentSession()).toBeNull();
  await expect(identityFetch("/v1/principals/me")).rejects.toThrow(
    /finish signing out/i,
  );
  expect(fetcher).not.toHaveBeenCalled();
});

it("rejects an Identity response that arrives after sign-out starts", async () => {
  const issuer = "https://identity.example";
  configureHost(createTestHost({ env: { VITE_IDENTITY_API: issuer } }));
  identitySeams.restoreSession({
    issuerOrigin: issuer,
    principalId: "old-principal",
    accessToken: "previous-token",
  });
  let release = () => {};
  let started = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      started();
      await gate;
      return new Response("{}", { status: 200 });
    }),
  );
  const response = identityFetch("/v1/principals/me");
  await begun;
  const entry = stageBoundRevocation(
    {
      issuerOrigin: issuer,
      principalId: "old-principal",
      sessionId: "ps_previous",
      proof: "e".repeat(64),
    },
    false,
  );
  advanceGuestReturnEpoch();
  forgetBoundRevocation(entry.key);
  release();
  await expect(response).rejects.toThrow(/session ended/i);
  expect(currentSession()).toBeNull();
});

it("refuses cookie restoration when shared revocation storage is unavailable", async () => {
  const issuer = "https://identity.example";
  configureHost(createTestHost({ env: { VITE_IDENTITY_API: issuer } }));
  const binding = {
    issuerOrigin: issuer,
    principalId: "previous",
    sessionId: "ps_previous",
    proof: "f".repeat(64),
  };
  saveCookieBinding(binding);
  stageBoundRevocation(binding, false);
  const original = host();
  configureHost({
    ...original,
    storage: { ...original.storage, local: undefined },
  });
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(identitySeams.resumeSession()).rejects.toThrow(
    /check browser storage/i,
  );
  expect(fetcher).not.toHaveBeenCalled();
});

it("retains a bearer for revocation when shared storage becomes unavailable", async () => {
  const issuer = "https://identity.example";
  configureHost(createTestHost({ env: { VITE_IDENTITY_API: issuer } }));
  const active = {
    issuerOrigin: issuer,
    principalId: "previous",
    accessToken: "previous-token",
  };
  identitySeams.restoreSession(active);
  const original = host();
  configureHost({
    ...original,
    storage: { ...original.storage, local: undefined },
  });
  expect(currentSession()).toBeNull();
  configureHost(original);
  expect(currentSession()).toMatchObject(active);
  const fetcher = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(null, { status: 204 }),
  );
  vi.stubGlobal("fetch", fetcher);
  endSession();
  await settleRevokes();
  const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
  expect(headers.get("authorization")).toBe("Bearer previous-token");
});
