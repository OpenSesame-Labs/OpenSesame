/** @vitest-environment jsdom */
/** Enforce Allow guests for fresh and resumed guest vaults. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionStore } from "../ports.js";
import {
  HOST,
  IDENTITY,
  jsonResponse,
  provisionalBody,
  stubBasic,
  stubFetch,
} from "./__tests__/identity-session-support.js";
import { loopbackProfileEligible } from "./__tests__/loopback-profile.js";
import { defaultCapabilityConnectors } from "./capabilities.js";
import { GUESTS_OFF_MESSAGE, setGuestsAllowed } from "./guest-access.js";
import {
  FRESH_GUEST_SIGN_OUT_MESSAGE,
  FRESH_GUEST_STATUS_UNKNOWN_MESSAGE,
  continueAsGuest,
  guestAuthDependencies,
  openVaultAfterSignIn,
  resumeGuestSession,
} from "./guest-auth.js";
import {
  clearHostSession,
  clearSession,
  connectFreshProvisional,
  currentSession,
  endSession,
  identitySeams,
  restoreSession,
  settleRevokes,
} from "./identity.js";
import { clearGuestSessionPerson } from "./local-guest.js";
import { localNetworkFetchSeams } from "./local-network-fetch.js";
import { clearNotices } from "./notices.js";
import { saveSettings } from "./settings.js";

const createGuest = vi.fn();
const original = { ...guestAuthDependencies };

beforeEach(() => {
  createGuest.mockReset();
  createGuest.mockResolvedValue(undefined);
  Object.assign(guestAuthDependencies, {
    createGuest,
    isRemoteIdentityConfigured: () => false,
  });
});

afterEach(async () => {
  Object.assign(guestAuthDependencies, original);
  await setGuestsAllowed(true);
});

describe("guest roads under Allow guests", () => {
  it("opens a guest tomb while guests are allowed", async () => {
    await continueAsGuest();
    expect(createGuest).toHaveBeenCalledTimes(1);
  });

  it("refuses a fresh guest and a resume once guests are off", async () => {
    await setGuestsAllowed(false);
    await expect(continueAsGuest()).rejects.toThrow(GUESTS_OFF_MESSAGE);
    await expect(resumeGuestSession()).rejects.toThrow(GUESTS_OFF_MESSAGE);
    expect(createGuest).not.toHaveBeenCalled();
  });
});

describe("fresh guest admission", () => {
  const currentSession = vi.fn();
  const loadFederationSession = vi.fn();
  const inspectRemoteSession = vi.fn();
  const resumeSession = vi.fn();
  const connectProvisional = vi.fn();
  const vaultStatus = vi.fn();

  beforeEach(() => {
    sessionStorage.clear();
    clearNotices();
    currentSession.mockReset().mockReturnValue(null);
    loadFederationSession.mockReset().mockReturnValue(null);
    inspectRemoteSession.mockReset().mockResolvedValue({ kind: "absent" });
    resumeSession.mockReset().mockResolvedValue(null);
    connectProvisional
      .mockReset()
      .mockResolvedValue({ principalId: "prn_guest" });
    vaultStatus.mockReset().mockReturnValue("unlocked");
    Object.assign(guestAuthDependencies, {
      currentSession,
      loadFederationSession,
      inspectRemoteSession,
      resumeSession,
      connectProvisional,
      vaultStatus,
      isRemoteIdentityConfigured: () => true,
      mintGuestPerson: original.mintGuestPerson,
      connectFreshProvisional: async () => {
        const result = await inspectRemoteSession();
        if (result.kind === "unknown")
          throw new Error(FRESH_GUEST_STATUS_UNKNOWN_MESSAGE);
        if (result.kind === "present" || currentSession())
          throw new Error(FRESH_GUEST_SIGN_OUT_MESSAGE);
        return {
          principalId: "prn_guest",
          accessToken: "guest-tok",
          issuerOrigin: "http://127.0.0.1:18788",
        };
      },
    });
  });
  afterEach(() => {
    sessionStorage.clear();
    clearNotices();
  });
  it("requires sign-out before replacing a live Identity session", async () => {
    currentSession.mockReturnValue({
      principalId: "prn_member",
      accessToken: "member-tok",
      issuerOrigin: "http://127.0.0.1:18788",
    });

    await expect(continueAsGuest()).rejects.toThrow(
      FRESH_GUEST_SIGN_OUT_MESSAGE,
    );
    expect(createGuest).not.toHaveBeenCalled();
    expect(connectProvisional).not.toHaveBeenCalled();
  });

  it("requires sign-out when an Identity cookie resumes after reload", async () => {
    inspectRemoteSession.mockResolvedValue({
      kind: "present",
      session: {
        principalId: "prn_member",
        accessToken: "cookie:prn_member",
        cookieOnly: true,
        issuerOrigin: "http://127.0.0.1:18788",
      },
    });

    await expect(continueAsGuest()).rejects.toThrow(
      FRESH_GUEST_SIGN_OUT_MESSAGE,
    );
    expect(createGuest).not.toHaveBeenCalled();
  });

  it("fails closed when the remote cookie status is unknown", async () => {
    inspectRemoteSession.mockResolvedValue({ kind: "unknown" });

    await expect(continueAsGuest()).rejects.toThrow(
      FRESH_GUEST_STATUS_UNKNOWN_MESSAGE,
    );
    expect(createGuest).not.toHaveBeenCalled();
    expect(connectProvisional).not.toHaveBeenCalled();
  });

  it("rechecks local session state after the remote probe", async () => {
    let finishProbe: (() => void) | undefined;
    inspectRemoteSession.mockReturnValue(
      new Promise((resolve) => {
        finishProbe = () => resolve({ kind: "absent" });
      }),
    );

    const opening = continueAsGuest();
    currentSession.mockReturnValue({
      principalId: "prn_member",
      accessToken: "member-tok",
      issuerOrigin: "http://127.0.0.1:18788",
    });
    finishProbe?.();

    await expect(opening).rejects.toThrow(FRESH_GUEST_SIGN_OUT_MESSAGE);
    expect(createGuest).not.toHaveBeenCalled();
  });

  it("rechecks at the guest-person commit after waiting for its lock", async () => {
    let enterMint: (() => void) | undefined;
    let releaseMint: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enterMint = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseMint = resolve;
    });
    guestAuthDependencies.mintGuestPerson = vi.fn(async (validate) => {
      enterMint?.();
      await released;
      validate?.();
      throw new Error("unreachable");
    });

    const opening = continueAsGuest();
    await entered;
    currentSession.mockReturnValue({
      principalId: "prn_member",
      accessToken: "member-tok",
      issuerOrigin: "http://127.0.0.1:18788",
    });
    releaseMint?.();

    await expect(opening).rejects.toThrow(FRESH_GUEST_SIGN_OUT_MESSAGE);
    expect(createGuest).not.toHaveBeenCalled();
  });

  it("requires sign-out before replacing a federated session", async () => {
    loadFederationSession.mockReturnValue({ idToken: "signed-in" });

    await expect(continueAsGuest()).rejects.toThrow(
      FRESH_GUEST_SIGN_OUT_MESSAGE,
    );
    expect(resumeSession).not.toHaveBeenCalled();
    expect(createGuest).not.toHaveBeenCalled();
  });

  it("still resumes the established guest person", async () => {
    await continueAsGuest();
    currentSession.mockReturnValue({
      principalId: "prn_guest",
      accessToken: "guest-tok",
      issuerOrigin: "http://127.0.0.1:18788",
    });

    createGuest.mockClear();
    await expect(resumeGuestSession()).resolves.toBeUndefined();
    expect(createGuest).toHaveBeenCalledWith({ resume: true });
  });

  it("treats resume without a surviving guest person as a fresh guest", async () => {
    clearGuestSessionPerson();
    currentSession.mockReturnValue({
      principalId: "prn_member",
      accessToken: "member-tok",
      issuerOrigin: "http://127.0.0.1:18788",
    });

    await expect(resumeGuestSession()).rejects.toThrow(
      FRESH_GUEST_SIGN_OUT_MESSAGE,
    );
    expect(createGuest).not.toHaveBeenCalled();
  });

  it("still opens an empty vault after completed sign-in", async () => {
    currentSession.mockReturnValue({
      principalId: "prn_member",
      accessToken: "member-tok",
      issuerOrigin: "http://127.0.0.1:18788",
    });
    vaultStatus.mockReturnValueOnce("empty").mockReturnValue("unlocked");

    await expect(openVaultAfterSignIn()).resolves.toBe(true);
    expect(createGuest).toHaveBeenCalledWith({ resume: true });
  });
});

describe("remote guest admission", () => {
  const previousEligibility = localNetworkFetchSeams.eligible;
  beforeEach(async () => {
    stubBasic();
    endSession();
    await settleRevokes();
    sessionStore().removeItem("opensesame.guest.identity-isolated");
    localNetworkFetchSeams.eligible = loopbackProfileEligible;
    clearSession();
    clearHostSession();
    saveSettings({
      hostApi: HOST,
      identityApi: IDENTITY,
      daemonApi: "http://127.0.0.1:18790",
      capabilityConnectors: {
        ...defaultCapabilityConnectors(),
        encryption: { providerId: "webcrypto" },
        history: { providerId: "github" },
      },
    });
  });
  afterEach(async () => {
    await settleRevokes();
    sessionStore().removeItem("opensesame.guest.identity-isolated");
    localNetworkFetchSeams.eligible = previousEligibility;
    clearSession();
    clearHostSession();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  it.each([
    [401, {}, "absent"],
    [503, {}, "unknown"],
    [200, {}, "unknown"],
  ] as const)(
    "classifies remote cookie inspection status %s as %s",
    async (status, body, kind) => {
      stubFetch((url) => {
        if (url === `${IDENTITY}/v1/principals/me`) {
          return jsonResponse(body, status);
        }
        return jsonResponse({}, 404);
      });

      await expect(identitySeams.inspectRemoteSession()).resolves.toMatchObject(
        {
          kind,
        },
      );
    },
  );

  it("returns the validated HttpOnly principal as a present session", async () => {
    stubFetch((url) => {
      if (url === `${IDENTITY}/v1/principals/me`) {
        return jsonResponse({ id: "prn_cookie" });
      }
      return jsonResponse({}, 404);
    });

    await expect(identitySeams.inspectRemoteSession()).resolves.toMatchObject({
      kind: "present",
      session: { principalId: "prn_cookie", cookieOnly: true },
    });
    expect(currentSession()).toBeNull();
  });

  it("offers a retry without minting when the remote session cannot be checked", async () => {
    const requests = stubFetch(() => jsonResponse({}, 503));
    await expect(connectFreshProvisional()).rejects.toThrow(
      FRESH_GUEST_STATUS_UNKNOWN_MESSAGE,
    );
    expect(
      requests.mock.calls.some(([url]) =>
        String(url).endsWith("/v1/principals/provisional"),
      ),
    ).toBe(false);
  });

  it("keeps guest admission closed after a failed revoke and permits a later retry", async () => {
    let online = false;
    let cookieActive = true;
    const requests = stubFetch((url, init) => {
      if (!online) return Promise.reject(new Error("offline"));
      if (url === `${IDENTITY}/v1/principals/provisional/revoke`) {
        if (init?.credentials === "include") cookieActive = false;
        return jsonResponse({});
      }
      if (url === `${IDENTITY}/v1/principals/me`) {
        return cookieActive
          ? jsonResponse({ id: "prn_member" })
          : jsonResponse({}, 401);
      }
      if (url === `${IDENTITY}/v1/principals/provisional`) {
        return jsonResponse(provisionalBody());
      }
      return jsonResponse({}, 404);
    });
    restoreSession({
      principalId: "prn_member",
      accessToken: "member-token",
      issuerOrigin: new URL(IDENTITY).origin,
    });
    endSession();
    await expect(connectFreshProvisional()).rejects.toThrow(
      FRESH_GUEST_STATUS_UNKNOWN_MESSAGE,
    );
    online = true;
    await expect(connectFreshProvisional()).rejects.toThrow(
      FRESH_GUEST_SIGN_OUT_MESSAGE,
    );
    expect(
      requests.mock.calls.some(([url]) =>
        String(url).endsWith("/v1/principals/provisional"),
      ),
    ).toBe(false);
    endSession();
    await expect(connectFreshProvisional()).resolves.toMatchObject({
      principalId: "principal_1",
    });
  });

  it("does not restore a cookie session after sign-out during inspection", async () => {
    let finishProbe: ((response: Response) => void) | undefined;
    stubFetch((url) => {
      if (url === `${IDENTITY}/v1/principals/me`) {
        return new Promise<Response>((resolve) => {
          finishProbe = resolve;
        });
      }
      return jsonResponse({});
    });
    const inspecting = identitySeams.inspectRemoteSession();
    await vi.waitFor(() => expect(finishProbe).toBeTypeOf("function"));
    endSession();
    finishProbe?.(jsonResponse({ id: "prn_old_member" }));
    const result = await inspecting;
    await settleRevokes();
    expect(result).toEqual({ kind: "unknown" });
    expect(currentSession()).toBeNull();
  });
});
