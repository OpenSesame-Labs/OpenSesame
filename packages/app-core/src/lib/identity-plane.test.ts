/**
 * The Identity plane's truth table (ADR 0160): which plane answers, and which
 * route families it serves.
 */

/** @vitest-environment jsdom */
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
import {
  registerDeviceRoutes,
  resetDeviceRoutesForTests,
} from "./device-identity-routes.js";
import {
  FRESH_GUEST_SIGN_OUT_MESSAGE,
  FRESH_GUEST_STATUS_UNKNOWN_MESSAGE,
} from "./guest-auth.js";
import {
  clearHostSession,
  clearSession,
  connectFreshProvisional,
  connectProvisional,
  currentSession,
  endSession,
  identityFetch,
  identityJson,
  restoreSession,
  settleRevokes,
} from "./identity.js";
import {
  DEVICE_CORE_FAMILIES,
  DEVICE_NEVER_FAMILIES,
  IDENTITY_ROUTE_FAMILIES,
  type IdentityRouteFamily,
  identityPlane,
  identityServes,
} from "./identity-plane.js";
import { localNetworkFetchSeams } from "./local-network-fetch.js";
import { saveSettings } from "./settings.js";

function settings(identityApi: string): void {
  saveSettings({
    hostApi: "",
    identityApi,
    daemonApi: "",
    capabilityConnectors: {
      ...defaultCapabilityConnectors(),
      encryption: { providerId: "webcrypto" },
      history: { providerId: "github" },
    },
  });
}

const CONTRIBUTABLE = IDENTITY_ROUTE_FAMILIES.filter(
  (family) =>
    !DEVICE_CORE_FAMILIES.includes(family) &&
    !DEVICE_NEVER_FAMILIES.includes(family),
);

function contribute(id: string, serves: IdentityRouteFamily[]) {
  return registerDeviceRoutes({
    id,
    routes: Object.fromEntries(
      serves.map((family) => [family, async () => null]),
    ),
  });
}

beforeEach(() => {
  settings("");
  resetDeviceRoutesForTests();
});

afterEach(() => {
  resetDeviceRoutesForTests();
});

describe("identityPlane", () => {
  it("is the device when Settings names no Identity API", () => {
    expect(identityPlane()).toBe("device");
  });

  it("is remote when Settings names one, and the device when it is cleared again", () => {
    settings("https://id.example.test");
    expect(identityPlane()).toBe("remote");
    settings("");
    expect(identityPlane()).toBe("device");
  });
});

describe("identityServes on the device plane", () => {
  it("partitions the closed set: core, contributable, never", () => {
    const all = new Set<IdentityRouteFamily>([
      ...DEVICE_CORE_FAMILIES,
      ...CONTRIBUTABLE,
      ...DEVICE_NEVER_FAMILIES,
    ]);
    expect([...all].sort()).toEqual([...IDENTITY_ROUTE_FAMILIES].sort());
    expect(DEVICE_CORE_FAMILIES).toEqual(["session"]);
    expect(CONTRIBUTABLE).toEqual([
      "audit",
      "requests",
      "notifications",
      "directory",
    ]);
  });

  it("always serves a session, with nothing registered", () => {
    expect(identityServes("session")).toBe(true);
  });

  it("serves nothing else until a capability that is on registers it", () => {
    for (const family of CONTRIBUTABLE) {
      expect(identityServes(family)).toBe(false);
    }
    const off = contribute("identity.local-iam", ["directory", "audit"]);
    expect(identityServes("directory")).toBe(true);
    expect(identityServes("audit")).toBe(true);
    expect(identityServes("requests")).toBe(false);
    expect(identityServes("notifications")).toBe(false);
    off();
    expect(identityServes("directory")).toBe(false);
    expect(identityServes("audit")).toBe(false);
  });

  it("never serves what needs a server, however it is asked", () => {
    for (const family of DEVICE_NEVER_FAMILIES) {
      expect(identityServes(family)).toBe(false);
      expect(() => contribute("greedy", [family])).toThrow(TypeError);
      expect(identityServes(family)).toBe(false);
    }
  });

  it("says plainly which families need a server", () => {
    expect([...DEVICE_NEVER_FAMILIES].sort()).toEqual([
      "federation-callback",
      "mfa-codes",
      "org-signin",
      "wallet",
    ]);
  });
});

describe("identityServes on a remote plane", () => {
  it("serves every family, because it is asked for all of them over the wire", () => {
    settings("https://id.example.test");
    for (const family of IDENTITY_ROUTE_FAMILIES) {
      expect(identityServes(family)).toBe(true);
    }
  });

  it("does not depend on what the device registered", () => {
    settings("https://id.example.test");
    contribute("identity.local-iam", ["directory"]);
    resetDeviceRoutesForTests();
    expect(identityServes("directory")).toBe(true);
  });
});

describe("guest bearer isolation", () => {
  const previousEligibility = localNetworkFetchSeams.eligible;
  beforeEach(async () => {
    stubBasic();
    // Eligible first, so this cleanup's revoke is not left owed.
    localNetworkFetchSeams.eligible = loopbackProfileEligible;
    endSession();
    await settleRevokes();
    sessionStore().removeItem("opensesame.guest.identity-isolated");
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

  it("keeps late member cookies out of guest requests and after bearer loss", async () => {
    let memberSignedIn = false;
    const requests = stubFetch((url, init) => {
      if (url === `${IDENTITY}/v1/principals/me`) {
        return memberSignedIn
          ? jsonResponse({ id: "prn_member" })
          : jsonResponse({}, 401);
      }
      if (url === `${IDENTITY}/v1/principals/provisional`)
        return jsonResponse(provisionalBody("guest-token"));
      if (url === `${IDENTITY}/v1/principals/provisional/revoke`) {
        if (init?.credentials === "include") memberSignedIn = false;
        return jsonResponse({});
      }
      return jsonResponse({ ok: true });
    });
    await connectFreshProvisional();
    memberSignedIn = true;
    await identityJson("/v1/principals/link-identities", { method: "POST" });
    const link = requests.mock.calls.find(([url]) =>
      String(url).endsWith("/link-identities"),
    );
    expect(link?.[1]?.credentials).toBe("omit");
    expect(new Headers(link?.[1]?.headers).get("authorization")).toBe(
      "Bearer guest-token",
    );
    // A reload loses the bearer while the non-secret isolation marker survives.
    clearSession();
    await identityFetch("/v1/claims");
    expect(requests.mock.calls.at(-1)?.[1]?.credentials).toBe("omit");
    await expect(connectProvisional()).rejects.toThrow(
      FRESH_GUEST_SIGN_OUT_MESSAGE,
    );
    expect(currentSession()).toBeNull();
    expect(memberSignedIn).toBe(true);
  });

  it("revokes only the guest bearer when a member cookie arrives later", async () => {
    const requests = stubBasic();
    await connectFreshProvisional();
    endSession();
    await settleRevokes();
    const revoke = requests.mock.calls.find(([url]) =>
      String(url).endsWith("/provisional/revoke"),
    );
    expect(revoke?.[1]?.credentials).toBe("omit");
    expect(new Headers(revoke?.[1]?.headers).get("authorization")).toBe(
      "Bearer identity_tok",
    );
  });

  it.each(["setItem", "getItem"] as const)(
    "fails closed when session storage %s fails",
    async (operation) => {
      const requests = stubBasic();
      vi.spyOn(Storage.prototype, operation).mockImplementation(() => {
        throw new Error("storage blocked");
      });
      await expect(connectFreshProvisional()).rejects.toThrow(
        "Allow browser session storage, then try again.",
      );
      await settleRevokes();
      expect(currentSession()).toBeNull();
      expect(
        requests.mock.calls.find(([url]) =>
          String(url).endsWith("/provisional/revoke"),
        )?.[1]?.credentials,
      ).toBe("omit");
    },
  );

  it("treats a damaged isolation marker as active", async () => {
    const requests = stubBasic();
    sessionStorage.setItem("opensesame.guest.identity-isolated", "damaged");
    await identityFetch("/v1/claims");
    expect(requests.mock.calls.at(-1)?.[1]?.credentials).toBe("omit");
    expect(sessionStorage.getItem("opensesame.guest.identity-isolated")).toBe(
      "damaged",
    );
  });

  it("does not clear a newer member session after a delayed guest 401", async () => {
    let answer: ((response: Response) => void) | undefined;
    const requests = stubFetch((url) => {
      if (url === `${IDENTITY}/v1/principals/me`) return jsonResponse({}, 401);
      if (url === `${IDENTITY}/v1/principals/provisional`)
        return jsonResponse(provisionalBody("old-guest"));
      if (url === `${IDENTITY}/v1/claims`)
        return new Promise<Response>((resolve) => {
          answer = resolve;
        });
      return jsonResponse({});
    });
    await connectFreshProvisional();
    const request = identityFetch("/v1/claims");
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    restoreSession({
      principalId: "prn_new_member",
      accessToken: "new-member-token",
      issuerOrigin: new URL(IDENTITY).origin,
    });
    answer?.(jsonResponse({}, 401));
    await request;
    await settleRevokes();
    expect(currentSession()?.principalId).toBe("prn_new_member");
    const revoke = requests.mock.calls.find(([url]) =>
      String(url).endsWith("/provisional/revoke"),
    );
    expect(revoke?.[1]?.credentials).toBe("omit");
    expect(new Headers(revoke?.[1]?.headers).get("authorization")).toBe(
      "Bearer old-guest",
    );
  });

  it("retries a failed guest revoke before sign-out and guest admission", async () => {
    let cookie = false;
    let revokeWorks = false;
    let answerMint: ((response: Response) => void) | undefined;
    let mints = 0;
    const requests = stubFetch((url, init) => {
      if (url === `${IDENTITY}/v1/principals/me`)
        return cookie
          ? jsonResponse({ id: "prn_member" })
          : jsonResponse({}, 401);
      if (url === `${IDENTITY}/v1/principals/provisional`) {
        mints += 1;
        if (mints > 1) return jsonResponse(provisionalBody("new-guest"));
        return new Promise<Response>((resolve) => {
          answerMint = resolve;
        });
      }
      if (url === `${IDENTITY}/v1/principals/provisional/revoke`) {
        if (init?.credentials === "omit")
          return jsonResponse({}, revokeWorks ? 200 : 503);
        cookie = false;
        return jsonResponse({});
      }
      return jsonResponse({}, 404);
    });
    const opening = connectFreshProvisional();
    await vi.waitFor(() => expect(answerMint).toBeTypeOf("function"));
    cookie = true;
    answerMint?.(jsonResponse(provisionalBody("old-guest")));
    await expect(opening).rejects.toThrow(FRESH_GUEST_SIGN_OUT_MESSAGE);
    await settleRevokes();
    await expect(connectFreshProvisional()).rejects.toThrow(
      FRESH_GUEST_STATUS_UNKNOWN_MESSAGE,
    );
    expect(mints).toBe(1);
    expect(cookie).toBe(true);
    revokeWorks = true;
    await expect(connectFreshProvisional()).rejects.toThrow(
      FRESH_GUEST_SIGN_OUT_MESSAGE,
    );
    endSession();
    await settleRevokes();
    expect(cookie).toBe(false);
    await expect(connectFreshProvisional()).resolves.toMatchObject({
      accessToken: "new-guest",
    });
    const guestRevokes = requests.mock.calls.filter(
      ([url, init]) =>
        String(url).endsWith("/revoke") && init?.credentials === "omit",
    );
    expect(guestRevokes.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps the guest marker after an expired or refused bearer", async () => {
    const requests = stubBasic((url) => {
      if (url === `${IDENTITY}/v1/claims`) return jsonResponse({}, 401);
      return undefined;
    });
    await connectFreshProvisional();
    await identityFetch("/v1/claims");
    expect(currentSession()).toBeNull();
    await identityFetch("/v1/claims");
    expect(requests.mock.calls.at(-1)?.[1]?.credentials).toBe("omit");
    expect(sessionStore().getItem("opensesame.guest.identity-isolated")).toBe(
      "1",
    );
  });
});
