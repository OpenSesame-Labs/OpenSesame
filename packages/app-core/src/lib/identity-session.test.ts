import { overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HOST,
  IDENTITY,
  jsonResponse,
  provisionalBody,
  stubBasic,
  stubFetch,
} from "./__tests__/identity-session-support.js";
import { loopbackProfileEligible } from "./__tests__/loopback-profile.js";
import { browserPairingSeams } from "./browser-pairing.js";
import { defaultCapabilityConnectors } from "./capabilities.js";
import {
  IdentityError,
  adoptToken,
  clearHostSession,
  clearSession,
  connectProvisional,
  currentSession,
  endSession,
  ensureIdentitySession,
  identityFetch,
  probeOrphanSession,
  restoreSession,
  settleRevokes,
} from "./identity.js";
import {
  clearCookieBinding,
  saveCookieBinding,
} from "./identity-cookie-binding.js";
import { localNetworkFetchSeams } from "./local-network-fetch.js";
import { saveSettings } from "./settings.js";

const networkEligible = localNetworkFetchSeams.eligible;

beforeEach(() => {
  localNetworkFetchSeams.eligible = loopbackProfileEligible;
  clearSession();
  clearCookieBinding();
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
  localNetworkFetchSeams.eligible = networkEligible;
  clearSession();
  clearHostSession();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("session lifecycle", () => {
  it("mints a provisional session and drops it on expiry", async () => {
    stubBasic();
    const session = await connectProvisional();
    expect(session.principalId).toBe("principal_1");
    expect(session.issuerOrigin).toBe(new URL(IDENTITY).origin);
    expect(currentSession()?.accessToken).toBe("identity_tok");
    await expect(ensureIdentitySession()).resolves.toBe(session);
  });

  it("forgets a session whose expiry has passed", async () => {
    stubFetch((url) => {
      if (url === `${IDENTITY}/v1/principals/me`) return jsonResponse({}, 401);
      if (url === `${IDENTITY}/v1/principals/provisional`) {
        return jsonResponse(provisionalBody());
      }
      if (url === `${IDENTITY}/v1/principals/provisional/revoke`) {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({}, 500);
    });
    await connectProvisional();

    // Time-travel past the session horizon.
    const now = Date.now();
    vi.setSystemTime(new Date("2100-01-01T00:00:00Z"));
    try {
      expect(currentSession()).toBeNull();
    } finally {
      vi.setSystemTime(now);
    }
  });

  it("revokes the session server-side with the bearer it forgets", async () => {
    const spy = stubBasic();
    await connectProvisional();

    endSession();

    expect(currentSession()).toBeNull();
    await vi.waitFor(() => {
      const revoke = spy.mock.calls.find(
        ([url]) =>
          String(url) === `${IDENTITY}/v1/principals/provisional/revoke`,
      );
      expect(revoke).toBeTruthy();
      expect(new Headers(revoke?.[1]?.headers).get("authorization")).toBe(
        "Bearer identity_tok",
      );
      expect(revoke?.[1]?.method).toBe("POST");
    });
  });

  it("reports no orphan when the cookie alone does not authenticate", async () => {
    stubBasic();
    await expect(probeOrphanSession()).resolves.toBe(false);
  });

  it("reports no orphan while a session is live, without probing", async () => {
    const spy = stubBasic();
    await connectProvisional();
    const calls = spy.mock.calls.length;
    await expect(probeOrphanSession()).resolves.toBe(false);
    expect(spy.mock.calls.length).toBe(calls);
  });

  it("surfaces a refused provisional mint with the API's message", async () => {
    stubFetch((url) => {
      if (url === `${IDENTITY}/v1/principals/me`) return jsonResponse({}, 401);
      if (url === `${IDENTITY}/v1/principals/provisional`) {
        return jsonResponse({ message: "provisioning disabled" }, 403);
      }
      return jsonResponse({}, 500);
    });
    const error = await connectProvisional().catch((caught) => caught);
    expect(error).toBeInstanceOf(IdentityError);
    expect(overlapCast(error).status).toBe(403);
    expect(overlapCast(error).message).toBe("provisioning disabled");
  });

  it("throws away a session minted after the user ended it", async () => {
    let release!: (response: Response) => void;
    const spy = stubFetch((url) => {
      if (url === `${IDENTITY}/v1/principals/me`) return jsonResponse({}, 401);
      if (url === `${IDENTITY}/v1/principals/provisional`) {
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      if (url === `${IDENTITY}/v1/principals/provisional/revoke`) {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({}, 500);
    });

    const pending = connectProvisional();
    await vi.waitFor(() => {
      expect(
        spy.mock.calls.some(
          ([url]) => url === `${IDENTITY}/v1/bound/session-mint`,
        ),
      ).toBe(true);
    });
    // The user locks while the mint is in flight.
    clearSession();
    release(jsonResponse(provisionalBody("late_token")));

    const error = await pending.catch((caught) => caught);
    expect(error).toBeInstanceOf(IdentityError);
    expect(overlapCast(error).status).toBe(409);
    expect(currentSession()).toBeNull();
    // The orphaned credential is revoked rather than left to live out its TTL.
    await vi.waitFor(() => {
      const revoke = spy.mock.calls.find(([url]) =>
        String(url).endsWith("/provisional/revoke"),
      );
      expect(new Headers(revoke?.[1]?.headers).get("authorization")).toBe(
        "Bearer late_token",
      );
    });
  });

  it("restores only the principal previously bound to this tab", async () => {
    saveCookieBinding({
      issuerOrigin: new URL(IDENTITY).origin,
      principalId: "principal_cookie",
      sessionId: "ps_old",
      proof: "a".repeat(64),
    });
    stubFetch((url) => {
      if (url === `${IDENTITY}/v1/bound/principals/me`) {
        const response = jsonResponse({ id: "principal_cookie" });
        response.headers.set("x-opensesame-cookie-bound", "1");
        return response;
      }
      return jsonResponse({}, 500);
    });
    const session = await connectProvisional();
    expect(session).toMatchObject({
      principalId: "principal_cookie",
      cookieOnly: true,
    });
    expect(session.accessToken).toBe("cookie:principal_cookie");
  });

  it("mints fresh when the cookie answer carries no principal id", async () => {
    const spy = stubBasic();
    await connectProvisional();
    expect(
      spy.mock.calls.some(
        ([url]) => url === `${IDENTITY}/v1/bound/session-mint`,
      ),
    ).toBe(true);
  });

  it("does not mint when Identity cannot confirm that the cookie is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        if (String(input) === `${IDENTITY}/v1/principals/provisional`) {
          return Promise.resolve(jsonResponse(provisionalBody()));
        }
        return Promise.reject(new TypeError("Failed to fetch"));
      }),
    );
    await expect(connectProvisional()).rejects.toThrow(
      /Identity sign-in could not be verified/,
    );
  });
});

describe("adopted tokens", () => {
  it("proves the pasted token with the cookie withheld", async () => {
    const spy = stubBasic((url, init) => {
      if (
        url === `${IDENTITY}/v1/principals/me` &&
        new Headers(init?.headers).get("authorization") ===
          "Bearer pasted_token"
      ) {
        return jsonResponse({ id: "principal_adopted" });
      }
      return undefined;
    });
    // A live session is ended before the token is adopted.
    await connectProvisional();

    await adoptToken("  pasted_token  ");

    const session = currentSession();
    expect(session).toMatchObject({
      principalId: "principal_adopted",
      accessToken: "pasted_token",
      adopted: true,
    });
    const probe = spy.mock.calls.find(
      ([url, init]) =>
        url === `${IDENTITY}/v1/principals/me` &&
        new Headers(init?.headers).get("authorization") ===
          "Bearer pasted_token",
    );
    expect(probe?.[1]?.credentials).toBe("omit");
    // The old session was revoked first.
    expect(
      spy.mock.calls.some(([url]) => String(url).endsWith("/revoke")),
    ).toBe(true);

    // An adopted token stands alone: no cookie rides along on API calls.
    await identityFetch("/v1/principals/me");
    const call = spy.mock.calls.at(-1);
    expect(call?.[1]?.credentials).toBe("omit");
  });

  it("does not adopt a token when a sign-out lands during the old revoke", async () => {
    restoreSession({
      principalId: "old",
      accessToken: "old_bearer",
      issuerOrigin: new URL(IDENTITY).origin,
    });
    let releaseRevoke: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseRevoke = resolve;
    });
    let revokes = 0;
    stubFetch((url, init) => {
      if (url === `${IDENTITY}/v1/principals/me`) {
        return new Headers(init?.headers).get("authorization") ===
          "Bearer pasted_token"
          ? jsonResponse({ id: "principal_adopted" })
          : jsonResponse({}, 401);
      }
      if (url.endsWith("/v1/principals/provisional/revoke")) {
        revokes += 1;
        return revokes === 1
          ? blocked.then(() => jsonResponse({ ok: true }))
          : jsonResponse({ ok: true });
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });

    const adopting = adoptToken("pasted_token");
    await vi.waitFor(() => expect(revokes).toBe(1));
    // The person signs out while the previous session's revoke is in flight.
    clearSession();
    releaseRevoke();
    await expect(adopting).rejects.toMatchObject({ status: 409 });
    await settleRevokes();
    expect(currentSession()).toBeNull();
    expect(revokes).toBeGreaterThanOrEqual(2);
  });

  it("rejects a token the API refuses, with its message", async () => {
    stubFetch((url) => {
      if (url === `${IDENTITY}/v1/principals/me`) {
        return jsonResponse({ message: "token expired" }, 401);
      }
      return jsonResponse({}, 500);
    });
    const error = await adoptToken("bad").catch((caught) => caught);
    expect(error).toBeInstanceOf(IdentityError);
    expect(overlapCast(error).message).toBe("token expired");
    expect(currentSession()).toBeNull();
  });

  it("keeps the working session when a pasted token is refused", async () => {
    stubBasic();
    await connectProvisional();
    expect(currentSession()?.accessToken).toBe("identity_tok");
    stubFetch((url) => {
      if (url === `${IDENTITY}/v1/principals/me`) {
        return jsonResponse({ message: "token expired" }, 401);
      }
      return jsonResponse({}, 500);
    });
    await expect(adoptToken("bad")).rejects.toThrow(/token expired/);
    expect(currentSession()?.accessToken).toBe("identity_tok");
  });

  it("falls back to the status when the refusal is not JSON", async () => {
    stubFetch(() => new Response("nope", { status: 403 }));
    await expect(adoptToken("bad")).rejects.toThrow(/Request failed \(403\)/);
  });
});

// Profile eligibility permits local health requests, never authenticated authority.
const originalPairingEligibility = browserPairingSeams.eligible;
beforeEach(() => {
  browserPairingSeams.eligible = loopbackProfileEligible;
});
afterEach(() => {
  browserPairingSeams.eligible = originalPairingEligibility;
});
