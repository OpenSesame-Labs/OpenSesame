/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  IDENTITY,
  jsonResponse,
  provisionalBody,
  stubBasic,
  stubFetch,
} from "./__tests__/identity-session-support.js";
import { loopbackProfileEligible } from "./__tests__/loopback-profile.js";
import {
  HostSessionError,
  clearHostSession,
  clearSession,
  connectProvisional,
  currentSession,
  endSession,
  ensureHostSession,
  hostFetch,
  identityFetch,
  identitySeams,
  inspectIdentityCookie,
  probeIdentity,
  settleRevokes,
} from "./identity.js";
import {
  clearCookieBinding,
  readCookieBinding,
  saveCookieBinding,
} from "./identity-cookie-binding.js";
import {
  cookieInspectionSeams,
  revokeObservedCookie,
} from "./identity-cookie-transport.js";
import { localNetworkFetchSeams } from "./local-network-fetch.js";
import { loadSettings, saveSettings } from "./settings.js";

const originalEligible = localNetworkFetchSeams.eligible;
beforeEach(() => {
  vi.spyOn(cookieInspectionSeams, "canObserveLegacyCookie").mockReturnValue(
    true,
  );
  localNetworkFetchSeams.eligible = loopbackProfileEligible;
  clearSession();
  clearHostSession();
  clearCookieBinding();
  saveSettings({ ...loadSettings(), identityApi: IDENTITY });
});

it("does not infer that a cross-site legacy cookie is absent from a 401", async () => {
  vi.mocked(cookieInspectionSeams.canObserveLegacyCookie).mockReturnValue(
    false,
  );
  const spy = stubBasic();
  await expect(inspectIdentityCookie()).resolves.toBe("unknown");
  await expect(connectProvisional()).rejects.toThrow(/could not be verified/i);
  expect(
    spy.mock.calls.some(([url]) =>
      String(url).endsWith("/v1/bound/session-mint"),
    ),
  ).toBe(false);
});

it("does not trust a missing bound-session endpoint as proof of sign-out", async () => {
  const fetcher = vi.fn(async (input: RequestInfo | URL) =>
    String(input).endsWith("/v1/bound/status")
      ? jsonResponse({}, 404)
      : jsonResponse({}, 401),
  );
  vi.stubGlobal("fetch", fetcher);
  await expect(inspectIdentityCookie()).resolves.toBe("unknown");
  await expect(revokeObservedCookie()).resolves.toMatchObject({ ok: false });
});

it("does not treat a malformed bound-session response as an empty session list", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith("/v1/bound/status")
        ? jsonResponse({ sessions: [], more: "unknown" })
        : jsonResponse({}, 401),
    ),
  );
  await expect(inspectIdentityCookie()).resolves.toBe("unknown");
  await expect(revokeObservedCookie()).resolves.toMatchObject({ ok: false });
});

it("does not carry a session to a different Identity path on the same host", async () => {
  stubBasic();
  await connectProvisional();
  expect(currentSession()).not.toBeNull();
  saveSettings({ ...loadSettings(), identityApi: `${IDENTITY}/other-service` });
  expect(currentSession()).toBeNull();
});

it("uses an isolated bearer for an explicit sign-in when browser cookies cannot be checked", async () => {
  vi.mocked(cookieInspectionSeams.canObserveLegacyCookie).mockReturnValue(
    false,
  );
  const spy = stubBasic((url) =>
    url.endsWith("/v1/principals/link-identities")
      ? jsonResponse({ ok: true })
      : undefined,
  );
  const session = await connectProvisional({ explicitSignIn: true });
  expect(session.unverifiedBrowserSessions).toBe(true);
  const mint = spy.mock.calls.find(([url]) =>
    String(url).endsWith("/v1/principals/provisional"),
  );
  expect(mint?.[1]?.credentials).toBe("omit");
  await identityFetch("/v1/principals/link-identities", { method: "POST" });
  const link = spy.mock.calls.find(([url]) =>
    String(url).endsWith("/v1/principals/link-identities"),
  );
  expect(link?.[1]?.credentials).toBe("omit");
  expect(new Headers(link?.[1]?.headers).get("authorization")).toBe(
    "Bearer identity_tok",
  );
});

it("requires explicit Host pairing without minting a local session", async () => {
  const fetcher = stubFetch(() => jsonResponse({}));
  await expect(ensureHostSession()).rejects.toBeInstanceOf(HostSessionError);
  expect(fetcher).not.toHaveBeenCalled();
});

it("does not exchange an Identity session for an unbound Host bearer", async () => {
  stubBasic();
  await connectProvisional();
  const fetcher = stubFetch(() => jsonResponse({}));
  await expect(hostFetch("/api/v1/sync/pull")).rejects.toMatchObject({
    code: "setup_required",
  });
  expect(fetcher).not.toHaveBeenCalled();
});

it("treats a 200 without OpenSesame health JSON as unreachable", async () => {
  stubFetch(() => new Response("<html>ok</html>", { status: 200 }));
  await expect(probeIdentity()).resolves.toBe("unreachable");
});

it("uses the bearer when the browser blocks the bound cookie", async () => {
  const spy = stubFetch((url) => {
    if (url.endsWith("/v1/principals/me")) return jsonResponse({}, 401);
    if (url.endsWith("/v1/principals/provisional"))
      return jsonResponse(provisionalBody());
    if (url.endsWith("/v1/principals/link-identities"))
      return jsonResponse({ ok: true });
    return jsonResponse({}, 401);
  });
  await connectProvisional();
  expect(readCookieBinding(new URL(IDENTITY).origin)).toBeNull();
  await identityFetch("/v1/principals/link-identities", { method: "POST" });
  const call = spy.mock.calls.find(([url]) =>
    String(url).endsWith("/v1/principals/link-identities"),
  );
  expect(new Headers(call?.[1]?.headers).get("authorization")).toBe(
    "Bearer identity_tok",
  );
  expect(call?.[1]?.credentials).toBe("omit");
});

it("uses the bound route only after proving that its cookie is usable", async () => {
  const spy = stubFetch((url) => {
    if (url.endsWith("/v1/bound/principals/me")) {
      const response = jsonResponse({ id: "principal_1" });
      response.headers.set("x-opensesame-cookie-bound", "1");
      return response;
    }
    if (url.endsWith("/v1/principals/me")) return jsonResponse({}, 401);
    if (url.endsWith("/v1/principals/provisional"))
      return jsonResponse(provisionalBody());
    if (url.endsWith("/v1/bound/principals/link-identities")) {
      const response = jsonResponse({ ok: true });
      response.headers.set("x-opensesame-cookie-bound", "1");
      return response;
    }
    return jsonResponse({}, 500);
  });
  await connectProvisional();
  expect(readCookieBinding(new URL(IDENTITY).origin)?.sessionId).toBe(
    "ps_test",
  );
  await identityFetch("/v1/principals/link-identities", { method: "POST" });
  const call = spy.mock.calls.find(([url]) =>
    String(url).endsWith("/v1/bound/principals/link-identities"),
  );
  expect(call?.[1]?.credentials).toBe("include");
});

it("revokes a minted session if sign-out wins during the cookie probe", async () => {
  let release = () => {};
  let started = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const probing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const spy = stubFetch(async (url) => {
    if (url.endsWith("/v1/bound/principals/me")) {
      started();
      await waiting;
      const response = jsonResponse({ id: "principal_1" });
      response.headers.set("x-opensesame-cookie-bound", "1");
      return response;
    }
    if (url.endsWith("/v1/principals/me")) return jsonResponse({}, 401);
    if (url.endsWith("/v1/principals/provisional"))
      return jsonResponse(provisionalBody());
    return jsonResponse({ ok: true });
  });
  const opening = connectProvisional();
  const refused = expect(opening).rejects.toMatchObject({ status: 409 });
  await probing;
  endSession();
  release();
  await refused;
  await settleRevokes();
  expect(currentSession()).toBeNull();
  const revoke = spy.mock.calls.find(
    ([url, init]) =>
      String(url).endsWith("/provisional/revoke") &&
      new Headers(init?.headers).get("authorization") === "Bearer identity_tok",
  );
  expect(new Headers(revoke?.[1]?.headers).get("authorization")).toBe(
    "Bearer identity_tok",
  );
  expect(revoke?.[1]?.credentials).toBe("omit");
});
afterEach(async () => {
  await settleRevokes();
  clearSession();
  localNetworkFetchSeams.eligible = originalEligible;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("never restores a cookie response that arrives after sign-out", async () => {
  saveCookieBinding({
    issuerOrigin: new URL(IDENTITY).origin,
    principalId: "previous_principal",
    sessionId: "ps_old",
    proof: "a".repeat(64),
  });
  let release = () => {};
  let started = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const probing = new Promise<void>((resolve) => {
    started = resolve;
  });
  stubFetch(async (url) => {
    if (url.endsWith("/v1/bound/principals/me")) {
      started();
      await waiting;
      const response = jsonResponse({ id: "previous_principal" });
      response.headers.set("x-opensesame-cookie-bound", "1");
      return response;
    }
    return jsonResponse({ ok: true });
  });
  const restoring = identitySeams.resumeSession();
  const refused = expect(restoring).rejects.toMatchObject({ status: 409 });
  await probing;
  endSession();
  release();
  await refused;
  expect(currentSession()).toBeNull();
});
