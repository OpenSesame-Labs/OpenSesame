/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost, host } from "../host.js";
import {
  IDENTITY,
  jsonResponse,
  provisionalBody,
  stubBasic,
  stubFetch,
} from "./__tests__/identity-session-support.js";
import { loopbackProfileEligible } from "./__tests__/loopback-profile.js";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
import { clearAuthOutcome, readAuthOutcome } from "./auth-outcome.js";
import {
  clearHostSession,
  clearSession,
  connectProvisional,
  endSession,
  probeOrphanSession,
  settleRevokes,
} from "./identity.js";
import {
  clearCookieBinding,
  saveCookieBinding,
} from "./identity-cookie-binding.js";
import { cookieInspectionSeams } from "./identity-cookie-transport.js";
import { localNetworkFetchSeams } from "./local-network-fetch.js";
import { clearNotices, listNotices } from "./notices.js";
import { signOut } from "./session-exit.js";
import { loadSettings, saveSettings } from "./settings.js";

const originalEligible = localNetworkFetchSeams.eligible;
const originalHost = host();
beforeEach(() => {
  configureHost({ ...originalHost, locks: webLocksDouble() });
  vi.spyOn(cookieInspectionSeams, "canObserveLegacyCookie").mockReturnValue(
    true,
  );
  localNetworkFetchSeams.eligible = loopbackProfileEligible;
  clearSession();
  clearHostSession();
  clearCookieBinding();
  clearAuthOutcome();
  clearNotices();
  saveSettings({ ...loadSettings(), identityApi: IDENTITY });
});
afterEach(async () => {
  await settleRevokes();
  clearSession();
  clearAuthOutcome();
  clearNotices();
  localNetworkFetchSeams.eligible = originalEligible;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  configureHost(originalHost);
});

it("waits for remote revocation before reporting sign-out complete", async () => {
  stubBasic();
  await connectProvisional();
  let release = () => {};
  let started = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  stubFetch(async (url) => {
    if (url.endsWith("/v1/principals/provisional/revoke")) {
      started();
      await gate;
      return jsonResponse({ ok: true });
    }
    return jsonResponse({}, 401);
  });
  try {
    signOut();
    await begun;
    expect(readAuthOutcome()).toBeNull();
    release();
    await settleRevokes();
    await vi.waitFor(() =>
      expect(readAuthOutcome()).toMatchObject({ kind: "signed_out" }),
    );
  } finally {
    release();
    clearAuthOutcome();
  }
});

it("retains a failed revoke for retry and never reports a completed sign-out", async () => {
  stubBasic();
  await connectProvisional();
  let available = false;
  const fetcher = stubFetch((url) => {
    if (url.endsWith("/v1/principals/provisional/revoke"))
      return jsonResponse({}, available ? 200 : 503);
    return jsonResponse({}, 401);
  });
  try {
    signOut();
    await expect(settleRevokes()).rejects.toThrow(/sign-out did not finish/i);
    await vi.waitFor(() =>
      expect(
        listNotices().some(
          (notice) => notice.id === "session.signout-incomplete",
        ),
      ).toBe(true),
    );
    expect(readAuthOutcome()).toBeNull();
    available = true;
    signOut();
    await settleRevokes();
    await vi.waitFor(() =>
      expect(readAuthOutcome()).toMatchObject({ kind: "signed_out" }),
    );
    expect(
      fetcher.mock.calls.filter(([url]) =>
        String(url).endsWith("/provisional/revoke"),
      ),
    ).toHaveLength(2);
  } finally {
    available = true;
    signOut();
    await settleRevokes();
    clearAuthOutcome();
  }
});

it("flags an orphan cookie when a revoke fails and the cookie still acts", async () => {
  let meResponds = (): Response => jsonResponse({}, 401);
  let revokeSucceeds = false;
  stubFetch((url) => {
    if (url === `${IDENTITY}/v1/principals/me`) return meResponds();
    if (url === `${IDENTITY}/v1/principals/provisional`)
      return jsonResponse(provisionalBody());
    if (url === `${IDENTITY}/v1/principals/provisional/revoke`)
      return jsonResponse({}, revokeSucceeds ? 200 : 500);
    return jsonResponse({}, 500);
  });
  await connectProvisional();
  meResponds = () => jsonResponse({ id: "principal_1" });
  try {
    endSession();
    await vi.waitFor(async () => {
      await expect(probeOrphanSession()).resolves.toBe(true);
    });
    await expect(settleRevokes()).rejects.toThrow(/sign-out did not finish/i);
  } finally {
    revokeSucceeds = true;
    endSession();
    await settleRevokes();
  }
});

it("revokes a bound browser session after a reload left no in-memory identity", async () => {
  saveCookieBinding({
    issuerOrigin: IDENTITY,
    principalId: "previous-principal",
    sessionId: "ps_previous",
    proof: "a".repeat(64),
  });
  const fetcher = stubFetch((url) => {
    if (url.endsWith("/v1/bound/proof-sign-out"))
      return new Response(null, { status: 204 });
    if (url.endsWith("/v1/principals/cookie-status"))
      return jsonResponse({}, 401);
    return jsonResponse({}, 500);
  });
  signOut();
  await settleRevokes();
  const revoked = fetcher.mock.calls.find(([url]) =>
    String(url).endsWith("/v1/bound/proof-sign-out"),
  );
  expect(
    new Headers(revoked?.[1]?.headers).get("x-opensesame-revoke-session"),
  ).toBe("ps_previous");
  expect(
    new Headers(revoked?.[1]?.headers).get("x-opensesame-revoke-secret"),
  ).toBe("a".repeat(64));
});

it("does not send an old session to a new Identity path while waiting for a lock", async () => {
  stubBasic();
  await connectProvisional();
  const original = host();
  const locks = webLocksDouble();
  configureHost({ ...original, locks });
  let release = () => {};
  let started = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = locks.request("opensesame:identity-cookie-session", async () => {
    started();
    await gate;
  });
  await begun;
  const fetcher = stubFetch((url) =>
    url.endsWith("/v1/principals/cookie-status")
      ? jsonResponse({}, 401)
      : jsonResponse({ ok: true }),
  );
  try {
    signOut();
    saveSettings({
      ...loadSettings(),
      identityApi: `${IDENTITY}/other-service`,
    });
    release();
    await held;
    await expect(settleRevokes()).rejects.toThrow(/sign-out did not finish/i);
    for (const [url, init] of fetcher.mock.calls) {
      if (!String(url).includes("/other-service/")) continue;
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("x-opensesame-session-proof")).toBeNull();
      expect(headers.get("x-opensesame-revoke-secret")).toBeNull();
    }
    saveSettings({ ...loadSettings(), identityApi: IDENTITY });
    signOut();
    await settleRevokes();
  } finally {
    release();
    saveSettings({ ...loadSettings(), identityApi: IDENTITY });
    signOut();
    await settleRevokes();
    configureHost(original);
    clearAuthOutcome();
  }
});
