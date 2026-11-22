/**
 * Device-native Identity host — provisional + claims without a remote API.
 */

import { overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionStore } from "../ports.js";
import {
  IDENTITY,
  jsonResponse,
  provisionalBody,
  stubFetch,
} from "./__tests__/identity-session-support.js";
import { loopbackProfileEligible } from "./__tests__/loopback-profile.js";
import { defaultCapabilityConnectors } from "./capabilities.js";
import {
  identityPlaneRequest,
  isDeviceIdentityMode,
  resolveIdentityBase,
} from "./device-identity.js";
import {
  deviceIdentityFetch,
  resetDeviceIdentitySessionsForTests,
} from "./device-identity-host.js";
import {
  clearSession,
  connectFreshProvisional,
  currentSession,
  endSession,
  identityFetch,
  identitySeams,
  identitySessionEpoch,
  orphanSessionActive,
  probeOrphanSession,
  rebindSession,
  restoreSession,
  settleRevokes,
} from "./identity.js";
import { flushBearerRevokes } from "./identity-token-proof.js";
import { localNetworkFetchSeams } from "./local-network-fetch.js";
import { loadSettings, saveSettings } from "./settings.js";
import {
  localDropClaimSeams,
  resetLocalDropClaimsForTests,
} from "./vault/local-drop-claims.js";

function emptyRemoteSettings(): void {
  saveSettings({
    hostApi: "",
    identityApi: "",
    daemonApi: "",
    capabilityConnectors: {
      ...defaultCapabilityConnectors(),
      encryption: { providerId: "webcrypto" },
      history: { providerId: "github" },
    },
  });
}

beforeEach(() => {
  emptyRemoteSettings();
  resetDeviceIdentitySessionsForTests();
  resetLocalDropClaimsForTests();
  localDropClaimSeams.claimBase = () => "http://localhost:5180/OpenSesame";
});

afterEach(() => {
  resetDeviceIdentitySessionsForTests();
  resetLocalDropClaimsForTests();
});

describe("Identity issuer changes", () => {
  const originalEligibility = localNetworkFetchSeams.eligible;
  const otherBase = "http://127.0.0.1:28788";
  const revokeUrl = `${IDENTITY}/v1/principals/provisional/revoke`;
  const reachedOther = (requests: ReturnType<typeof stubFetch>) =>
    requests.mock.calls.some(([url]) => String(url).startsWith(otherBase));
  const useBase = (base: string) =>
    saveSettings({ ...loadSettings(), identityApi: base });
  beforeEach(() => {
    localNetworkFetchSeams.eligible = loopbackProfileEligible;
    clearSession();
    useBase(IDENTITY);
  });
  afterEach(async () => {
    await settleRevokes();
    clearSession();
    localNetworkFetchSeams.eligible = originalEligibility;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not adopt a mint or send its bearer to a newly configured service", async () => {
    let answer: ((response: Response) => void) | undefined;
    const requests = stubFetch((url) => {
      if (url === `${IDENTITY}/v1/principals/me`) return jsonResponse({}, 401);
      if (url === `${IDENTITY}/v1/principals/provisional`)
        return new Promise<Response>((resolve) => {
          answer = resolve;
        });
      return jsonResponse({});
    });
    const opening = connectFreshProvisional();
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    useBase(otherBase);
    answer?.(jsonResponse(provisionalBody("old-issuer-token")));
    await expect(opening).rejects.toThrow("The sign-in service changed");
    expect(currentSession()).toBeNull();
    expect(reachedOther(requests)).toBe(false);
    useBase(IDENTITY);
    await expect(flushBearerRevokes(IDENTITY)).resolves.toBe(true);
    const revoke = requests.mock.calls.find(([url]) =>
      String(url).endsWith("/provisional/revoke"),
    );
    expect(revoke?.[0]).toBe(revokeUrl);
    expect(revoke?.[1]?.credentials).toBe("omit");
    expect(new Headers(revoke?.[1]?.headers).get("authorization")).toBe(
      "Bearer old-issuer-token",
    );
  });

  it.each(["inspection", "orphan"] as const)(
    "ignores a stale %s cookie probe after the service changes",
    async (kind) => {
      let answer: ((response: Response) => void) | undefined;
      stubFetch(
        () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          }),
      );
      const checking =
        kind === "inspection"
          ? identitySeams.inspectRemoteSession()
          : probeOrphanSession();
      await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
      useBase(otherBase);
      const before = orphanSessionActive();
      answer?.(jsonResponse({ id: "old-member" }));
      const result = await checking;
      if (kind === "inspection") expect(result).toEqual({ kind: "unknown" });
      expect(orphanSessionActive()).toBe(before);
      expect(currentSession()).toBeNull();
    },
  );

  it("does not use one service's cookie warning to sign out another service", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() {
        return values.size;
      },
    });
    const requests = stubFetch((url) =>
      url === `${IDENTITY}/v1/principals/me`
        ? jsonResponse({ id: "old-member" })
        : jsonResponse({}),
    );
    await expect(connectFreshProvisional()).rejects.toThrow(
      "Sign out of the current account first",
    );
    expect(orphanSessionActive()).toBe(true);
    useBase(otherBase);
    expect(orphanSessionActive()).toBe(false);
    sessionStore().setItem("opensesame.guest.identity-isolated", "1");
    endSession();
    await settleRevokes();
    expect(reachedOther(requests)).toBe(false);
    sessionStore().removeItem("opensesame.guest.identity-isolated");
  });

  it("discards a guest bearer if the service changes during the final cookie check", async () => {
    let probes = 0;
    let answer: ((response: Response) => void) | undefined;
    const requests = stubFetch((url) => {
      if (url === `${IDENTITY}/v1/principals/me`) {
        probes += 1;
        if (probes === 1) return jsonResponse({}, 401);
        return new Promise<Response>((resolve) => {
          answer = resolve;
        });
      }
      if (url === `${IDENTITY}/v1/principals/provisional`)
        return jsonResponse(provisionalBody("postcheck-token"));
      return jsonResponse({});
    });
    const opening = connectFreshProvisional();
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    useBase(otherBase);
    answer?.(jsonResponse({}, 401));
    await expect(opening).rejects.toThrow("The sign-in service changed");
    expect(currentSession()).toBeNull();
    expect(reachedOther(requests)).toBe(false);
    useBase(IDENTITY);
    await expect(flushBearerRevokes(IDENTITY)).resolves.toBe(true);
  });

  it.each(["link", "broker"] as const)(
    "does not send a delayed %s bearer to the new service",
    async (kind) => {
      const requests = stubFetch(() => jsonResponse({}));
      const epoch = identitySessionEpoch();
      useBase(otherBase);
      const attempt =
        kind === "link"
          ? rebindSession("old-token", epoch, IDENTITY)
          : Promise.resolve().then(() =>
              restoreSession(
                {
                  principalId: "member",
                  accessToken: "old-token",
                  issuerOrigin: new URL(IDENTITY).origin,
                },
                epoch,
                IDENTITY,
              ),
            );
      await expect(attempt).rejects.toThrow("The sign-in service changed");
      expect(currentSession()).toBeNull();
      expect(requests).not.toHaveBeenCalled();
      useBase(IDENTITY);
      await expect(flushBearerRevokes(IDENTITY)).resolves.toBe(true);
      expect(requests.mock.calls[0]?.[0]).toBe(revokeUrl);
      expect(requests.mock.calls[0]?.[1]?.credentials).toBe("omit");
    },
  );

  it("does not return an old service response after configuration changes", async () => {
    let answer: ((response: Response) => void) | undefined;
    const requests = stubFetch((url) => {
      if (url === `${IDENTITY}/v1/claims`)
        return new Promise<Response>((resolve) => {
          answer = resolve;
        });
      return jsonResponse({});
    });
    restoreSession({
      principalId: "member",
      accessToken: "member-token",
      issuerOrigin: new URL(IDENTITY).origin,
      issuerBase: IDENTITY,
    });
    const request = identityFetch("/v1/claims");
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    useBase(otherBase);
    answer?.(jsonResponse({ id: "old-service-data" }));
    await expect(request).rejects.toThrow("The sign-in service changed");
    expect(currentSession()).toBeNull();
    expect(reachedOther(requests)).toBe(false);
    useBase(IDENTITY);
    await expect(flushBearerRevokes(IDENTITY)).resolves.toBe(true);
  });

  it.each([true, false])(
    "binds a delayed sign-out to its original service (guest: %s)",
    async (guest) => {
      const requests = stubFetch(() => jsonResponse({}));
      restoreSession({
        principalId: "guest",
        accessToken: "guest-token",
        issuerOrigin: new URL(IDENTITY).origin,
        issuerBase: IDENTITY,
        bearerOnly: guest,
      });
      endSession();
      useBase(otherBase);
      await settleRevokes();
      expect(reachedOther(requests)).toBe(false);
      useBase(IDENTITY);
      await expect(flushBearerRevokes(IDENTITY)).resolves.toBe(true);
      expect(requests.mock.calls.at(-1)?.[0]).toBe(revokeUrl);
    },
  );

  it("keeps a held sign-out bound to its service until its response arrives", async () => {
    let answer: ((response: Response) => void) | undefined;
    let held = true;
    const requests = stubFetch((url) => {
      if (url === `${IDENTITY}/v1/principals/provisional/revoke` && held)
        return new Promise<Response>((resolve) => {
          answer = resolve;
        });
      return jsonResponse({});
    });
    restoreSession({
      principalId: "guest",
      accessToken: "held-token",
      issuerOrigin: new URL(IDENTITY).origin,
      issuerBase: IDENTITY,
      bearerOnly: true,
    });
    endSession();
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    useBase(otherBase);
    answer?.(jsonResponse({}));
    await settleRevokes();
    expect(reachedOther(requests)).toBe(false);
    held = false;
    useBase(IDENTITY);
    await expect(flushBearerRevokes(IDENTITY)).resolves.toBe(true);
    expect(
      requests.mock.calls.filter(([url]) => String(url).endsWith("/revoke")),
    ).toHaveLength(2);
  });

  it("does not carry a bearer between API paths on the same origin", async () => {
    const requests = stubFetch(() => jsonResponse({}));
    const firstBase = `${IDENTITY}/first`;
    useBase(firstBase);
    restoreSession({
      principalId: "guest",
      accessToken: "guest-token",
      issuerOrigin: new URL(IDENTITY).origin,
      issuerBase: firstBase,
    });
    useBase(`${IDENTITY}/second`);
    await identityFetch("/v1/claims");
    expect(currentSession()).toBeNull();
    expect(
      new Headers(requests.mock.calls.at(-1)?.[1]?.headers).has(
        "authorization",
      ),
    ).toBe(false);
    useBase(firstBase);
    await expect(flushBearerRevokes(firstBase)).resolves.toBe(true);
    expect(requests.mock.calls.at(-1)?.[0]).toBe(
      `${firstBase}/v1/principals/provisional/revoke`,
    );
  });
});

describe("device identity mode", () => {
  it("resolves identityBase to a public Pages issuer when settings are empty", () => {
    expect(isDeviceIdentityMode()).toBe(true);
    expect(resolveIdentityBase().length).toBeGreaterThan(0);
    expect(resolveIdentityBase()).toMatch(/^https?:\/\//);
  });

  it("mints provisional, answers /me, and serves a drop claim round-trip", async () => {
    const minted = await identityPlaneRequest("/v1/principals/provisional", {
      method: "POST",
      body: "{}",
    });
    expect(minted.status).toBe(201);
    const session = overlapCast(await minted.json());
    expect(String(session.principalId)).toMatch(/^prn_/);
    expect(String(session.accessToken).length).toBeGreaterThan(8);

    const me = await identityPlaneRequest("/v1/principals/me", {
      headers: { authorization: `Bearer ${String(session.accessToken)}` },
    });
    expect(me.status).toBe(200);
    const principal = overlapCast(await me.json());
    expect(principal.id).toBe(session.principalId);

    const claimRes = await deviceIdentityFetch("/v1/claims", {
      method: "POST",
      headers: {
        authorization: `Bearer ${String(session.accessToken)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type: "resource_bundle",
        targetManifest: { kind: "drop", digest: "abc", chunks: ["x"] },
        ttlSeconds: 120,
      }),
    });
    expect(claimRes.status).toBe(201);
    const claim = overlapCast(await claimRes.json());
    const poll = await deviceIdentityFetch(
      `/v1/claims/${encodeURIComponent(String(claim.claimId))}/poll`,
      { headers: { "x-claim-token": String(claim.claimToken) } },
    );
    expect(poll.status).toBe(200);
    expect(overlapCast(await poll.json()).status).toBe("pending");

    const presented = await deviceIdentityFetch("/v1/claims/present", {
      method: "POST",
      body: JSON.stringify({
        token: claim.claimToken,
        userCode: claim.userCode,
      }),
    });
    expect(presented.status).toBe(200);
    expect(overlapCast(await presented.json()).targetManifest).toEqual({
      kind: "drop",
      digest: "abc",
      chunks: ["x"],
    });
  });
});
