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
  identitySessionEpoch,
  rebindSession,
  restoreSession,
  settleRevokes,
} from "./identity.js";
import { localNetworkFetchSeams } from "./local-network-fetch.js";
import { saveSettings } from "./settings.js";

const networkEligible = localNetworkFetchSeams.eligible;

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
  localNetworkFetchSeams.eligible = networkEligible;
  clearSession();
  clearHostSession();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fresh guest sessions", () => {
  it("waits for sign-out before checking a fresh guest session", async () => {
    let finishRevoke: (() => void) | undefined;
    let cookieActive = true;
    const requests = stubFetch((url) => {
      if (url === `${IDENTITY}/v1/principals/provisional/revoke`) {
        return new Promise<Response>((resolve) => {
          finishRevoke = () => {
            cookieActive = false;
            resolve(jsonResponse({}));
          };
        });
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
    const opening = connectFreshProvisional().then(
      (session) => ({ session }),
      (error: unknown) => ({ error }),
    );
    await vi.waitFor(() => expect(finishRevoke).toBeTypeOf("function"));
    const checkedBeforeSignOut = requests.mock.calls.some(([url]) =>
      String(url).endsWith("/v1/principals/me"),
    );
    finishRevoke?.();
    const outcome = await opening;
    expect(checkedBeforeSignOut).toBe(false);
    expect(outcome).toMatchObject({ session: { principalId: "principal_1" } });
  });

  it("refuses a session installed while sign-out is still settling", async () => {
    let finishRevoke: (() => void) | undefined;
    stubFetch((url) => {
      if (url === `${IDENTITY}/v1/principals/provisional/revoke`) {
        return new Promise<Response>((resolve) => {
          finishRevoke = () => resolve(jsonResponse({}));
        });
      }
      return jsonResponse({}, 401);
    });
    endSession();
    const opening = connectFreshProvisional();
    await vi.waitFor(() => expect(finishRevoke).toBeTypeOf("function"));
    restoreSession({
      principalId: "prn_new_member",
      accessToken: "new-member-token",
      issuerOrigin: new URL(IDENTITY).origin,
    });
    finishRevoke?.();
    await expect(opening).rejects.toThrow(FRESH_GUEST_SIGN_OUT_MESSAGE);
    expect(currentSession()?.principalId).toBe("prn_new_member");
  });

  it("does not replace a session installed while the cookie check is in flight", async () => {
    let finishProbe: ((response: Response) => void) | undefined;
    const requests = stubFetch((url) => {
      if (url === `${IDENTITY}/v1/principals/me`) {
        return new Promise<Response>((resolve) => {
          finishProbe = resolve;
        });
      }
      if (url === `${IDENTITY}/v1/principals/provisional`) {
        return jsonResponse(provisionalBody());
      }
      return jsonResponse({}, 404);
    });
    const opening = connectFreshProvisional().then(
      (session) => ({ session }),
      (error: unknown) => ({ error }),
    );
    await vi.waitFor(() => expect(finishProbe).toBeTypeOf("function"));
    restoreSession({
      principalId: "prn_new_member",
      accessToken: "new-member-token",
      issuerOrigin: new URL(IDENTITY).origin,
    });
    finishProbe?.(jsonResponse({}, 401));
    const outcome = await opening;
    expect(outcome).toMatchObject({
      error: { message: FRESH_GUEST_SIGN_OUT_MESSAGE },
    });
    expect(currentSession()?.principalId).toBe("prn_new_member");
    expect(
      requests.mock.calls.some(([url]) =>
        String(url).endsWith("/v1/principals/provisional"),
      ),
    ).toBe(false);
  });

  it("marks the authority request as a fresh guest mint", async () => {
    let guarded = false;
    stubFetch((url, init) => {
      if (url === `${IDENTITY}/v1/principals/me`) {
        return jsonResponse({}, 401);
      }
      if (url === `${IDENTITY}/v1/principals/provisional`) {
        guarded =
          new Headers(init?.headers).get("x-opensesame-fresh-guest") === "1" &&
          init?.credentials === "omit";
        return jsonResponse(provisionalBody());
      }
      return jsonResponse({}, 404);
    });

    await expect(connectFreshProvisional()).resolves.toMatchObject({
      principalId: "principal_1",
    });
    expect(guarded).toBe(true);
  });

  it("surfaces the authority refusal when another tab installed a cookie", async () => {
    stubFetch((url) => {
      if (url === `${IDENTITY}/v1/principals/me`) {
        return jsonResponse({}, 401);
      }
      if (url === `${IDENTITY}/v1/principals/provisional`) {
        return jsonResponse(
          {
            error: "fresh_guest_requires_sign_out",
            message:
              "Sign out of the current account first, then continue as a fresh guest.",
          },
          409,
        );
      }
      return jsonResponse({}, 404);
    });

    await expect(connectFreshProvisional()).rejects.toThrow(
      "Sign out of the current account first",
    );
  });

  it("refuses a member session installed while the fresh mint is in flight", async () => {
    let answerMint: ((response: Response) => void) | undefined;
    stubFetch((url) => {
      if (url === `${IDENTITY}/v1/principals/me`) {
        return jsonResponse({}, 401);
      }
      if (url === `${IDENTITY}/v1/principals/provisional`) {
        return new Promise<Response>((resolve) => {
          answerMint = resolve;
        });
      }
      return jsonResponse({}, 404);
    });

    const minting = connectFreshProvisional();
    await vi.waitFor(() => expect(answerMint).toBeTypeOf("function"));
    restoreSession({
      principalId: "prn_member",
      accessToken: "member-token",
      issuerOrigin: new URL(IDENTITY).origin,
    });
    answerMint?.(jsonResponse(provisionalBody()));

    await expect(minting).rejects.toThrow(
      "Sign out of the current account first",
    );
    expect(currentSession()?.principalId).toBe("prn_member");
  });
  it("discards a held guest mint if another tab signs in before its response", async () => {
    let answerMint: ((response: Response) => void) | undefined;
    let memberSignedIn = false;
    const requests = stubFetch((url, init) => {
      if (url === `${IDENTITY}/v1/principals/me`) {
        return memberSignedIn
          ? jsonResponse({ id: "prn_member" })
          : jsonResponse({}, 401);
      }
      if (url === `${IDENTITY}/v1/principals/provisional`) {
        expect(init?.credentials).toBe("omit");
        return new Promise<Response>((resolve) => {
          answerMint = resolve;
        });
      }
      if (url === `${IDENTITY}/v1/principals/provisional/revoke`) {
        if (init?.credentials === "include") memberSignedIn = false;
        return jsonResponse({});
      }
      return jsonResponse({}, 404);
    });
    const opening = connectFreshProvisional();
    await vi.waitFor(() => expect(answerMint).toBeTypeOf("function"));
    memberSignedIn = true;
    answerMint?.(jsonResponse(provisionalBody("guest-token")));
    await expect(opening).rejects.toThrow(FRESH_GUEST_SIGN_OUT_MESSAGE);
    await settleRevokes();
    expect(currentSession()).toBeNull();
    expect(memberSignedIn).toBe(true);
    const revoke = requests.mock.calls.find(([url]) =>
      String(url).endsWith("/provisional/revoke"),
    );
    expect(revoke?.[1]?.credentials).toBe("omit");
    expect(new Headers(revoke?.[1]?.headers).get("authorization")).toBe(
      "Bearer guest-token",
    );
  });

  it.each([503, 200])(
    "discards the minted bearer when its post-mint cookie check is %s",
    async (status) => {
      let probes = 0;
      const requests = stubFetch((url) => {
        if (url === `${IDENTITY}/v1/principals/me`) {
          probes += 1;
          return probes === 1
            ? jsonResponse({}, 401)
            : jsonResponse({}, status);
        }
        if (url === `${IDENTITY}/v1/principals/provisional`)
          return jsonResponse(provisionalBody("guest-token"));
        return jsonResponse({});
      });
      await expect(connectFreshProvisional()).rejects.toThrow(
        FRESH_GUEST_STATUS_UNKNOWN_MESSAGE,
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
});

describe("rebound sessions", () => {
  it("revokes a late guest link token without touching a member cookie", async () => {
    const spy = stubBasic();
    await connectFreshProvisional();
    const linkStartedIn = identitySessionEpoch();
    endSession();
    await expect(
      rebindSession("late-link-token", linkStartedIn),
    ).rejects.toMatchObject({
      status: 409,
    });
    await settleRevokes();
    const revokes = spy.mock.calls.filter(([url]) =>
      String(url).endsWith("/revoke"),
    );
    expect(revokes.length).toBe(2);
    expect(revokes.every(([, init]) => init?.credentials === "omit")).toBe(
      true,
    );
  });

  it("rebinds without presenting the cookie that already names the new session", async () => {
    const spy = stubBasic((url, init) => {
      if (
        url === `${IDENTITY}/v1/principals/me` &&
        new Headers(init?.headers).get("authorization") ===
          "Bearer " + "rebound_token"
      ) {
        return jsonResponse({ id: "principal_existing" });
      }
      return undefined;
    });
    await connectProvisional();

    await rebindSession("rebound_token");
    await settleRevokes();

    expect(currentSession()).toMatchObject({
      principalId: "principal_existing",
      accessToken: "rebound_token",
    });
    // The previous Bearer is revoked with cookies withheld: the revoke route
    // ends every credential a request presents, and the cookie already holds
    // the rebound token — presenting it would end the new session too.
    const revoke = spy.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith("/v1/principals/provisional/revoke") &&
        new Headers(init?.headers).get("authorization") ===
          "Bearer identity_tok",
    );
    expect(revoke).toBeTruthy();
    expect(new Headers(revoke?.[1]?.headers).get("authorization")).toBe(
      "Bearer " + "identity_tok",
    );
    expect(revoke?.[1]?.credentials).toBe("omit");
  });

  it("ends the rebound token when the session was ended while its link was in flight", async () => {
    const spy = stubBasic();
    await connectProvisional();
    const linkStartedIn = identitySessionEpoch();

    // Sign-out lands while POST /link-identities is still out.
    endSession();

    await expect(
      rebindSession("rebound_token", linkStartedIn),
    ).rejects.toMatchObject({ status: 409 });
    await settleRevokes();

    expect(currentSession()).toBeNull();
    // The server bound a session and the cookie to this token, so it is
    // revoked rather than left live with nobody holding it.
    const revoked = spy.mock.calls
      .filter(([url]) =>
        String(url).endsWith("/v1/principals/provisional/revoke"),
      )
      .map(([, init]) => new Headers(init?.headers).get("authorization"));
    expect(revoked).toContain("Bearer " + "rebound_token");
  });
});
