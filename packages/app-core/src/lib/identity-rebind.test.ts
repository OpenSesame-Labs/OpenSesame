import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HOST,
  IDENTITY,
  jsonResponse,
  stubBasic,
} from "./__tests__/identity-session-support.js";
import { loopbackProfileEligible } from "./__tests__/loopback-profile.js";
import { defaultCapabilityConnectors } from "./capabilities.js";
import {
  clearHostSession,
  clearSession,
  connectProvisional,
  currentSession,
  endSession,
  identitySessionEpoch,
  rebindSession,
  settleRevokes,
} from "./identity.js";
import { localNetworkFetchSeams } from "./local-network-fetch.js";
import { saveSettings } from "./settings.js";

const networkEligible = localNetworkFetchSeams.eligible;

beforeEach(() => {
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

afterEach(() => {
  localNetworkFetchSeams.eligible = networkEligible;
  clearSession();
  clearHostSession();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("rebound sessions", () => {
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
    const revoke = spy.mock.calls.find(([url]) =>
      String(url).endsWith("/v1/principals/provisional/revoke"),
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
