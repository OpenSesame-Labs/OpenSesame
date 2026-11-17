import { overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureHost, host } from "../host.js";
import { createTestHost } from "../test-host.js";
import {
  HOST,
  IDENTITY,
  jsonResponse,
  stubBasic,
  stubFetch,
} from "./__tests__/identity-session-support.js";
import { loopbackProfileEligible } from "./__tests__/loopback-profile.js";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
import { browserPairingSeams } from "./browser-pairing.js";
import { defaultCapabilityConnectors } from "./capabilities.js";
import {
  IdentityError,
  clearHostSession,
  clearSession,
  connectProvisional,
  currentSession,
  endSession,
  ensureIdentitySession,
  fetchPrincipal,
  identityFetch,
  identityJson,
  noteUnauthorized,
  probeIdentity,
  restoreSession,
  settleRevokes,
} from "./identity.js";
import { clearCookieBinding } from "./identity-cookie-binding.js";
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

describe("identityFetch and readers", () => {
  it("waits for an in-flight request before revocation can complete sign-out", async () => {
    const originalHost = host();
    configureHost(createTestHost({ locks: webLocksDouble() }));
    let releaseRequest: () => void = () => undefined;
    const requestGate = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    let requestStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    let revoked = false;
    restoreSession({
      principalId: "principal_1",
      accessToken: "identity_tok",
      issuerOrigin: new URL(IDENTITY).origin,
    });
    stubFetch(async (url) => {
      if (url === `${IDENTITY}/v1/x`) {
        requestStarted();
        await requestGate;
        return jsonResponse({ ok: true });
      }
      if (url === `${IDENTITY}/v1/principals/provisional/revoke`) {
        revoked = true;
        return jsonResponse({ ok: true });
      }
      return jsonResponse({}, 404);
    });
    try {
      const request = identityFetch("/v1/x");
      await started;
      endSession();
      await Promise.resolve();
      expect(revoked).toBe(false);
      releaseRequest();
      await expect(request).rejects.toMatchObject({ status: 409 });
      await settleRevokes();
      expect(revoked).toBe(true);
    } finally {
      releaseRequest();
      configureHost(originalHost);
    }
  });

  it("attaches the bearer and defaults the content type for bodies", async () => {
    const spy = stubBasic((url, init) => {
      if (
        url === `${IDENTITY}/v1/principals/me` &&
        new Headers(init?.headers).get("authorization") ===
          "Bearer identity_tok"
      ) {
        return jsonResponse({
          id: "principal_1",
          state: "active",
          assurance: "provisional",
          createdAt: "2026-08-01T00:00:00Z",
          updatedAt: "2026-08-01T00:00:00Z",
          version: 1,
          identities: [],
        });
      }
      return undefined;
    });
    await connectProvisional();

    const principal = await fetchPrincipal();
    expect(principal.id).toBe("principal_1");
    const call = spy.mock.calls.at(-1);
    expect(new Headers(call?.[1]?.headers).get("authorization")).toBe(
      "Bearer identity_tok",
    );
    expect(call?.[1]?.credentials).toBe("omit");

    await identityFetch("/v1/x", { method: "POST", body: "{}" });
    const post = spy.mock.calls.at(-1);
    expect(new Headers(post?.[1]?.headers).get("content-type")).toBe(
      "application/json",
    );
  });

  it("ends the session when the API refuses the bearer", async () => {
    stubBasic((url) => {
      if (url === `${IDENTITY}/v1/principals/me`) {
        return jsonResponse({ error: "revoked" }, 401);
      }
      return undefined;
    });
    await connectProvisional();

    const res = await identityFetch("/v1/principals/me");
    expect(res.status).toBe(401);
    expect(currentSession()).toBeNull();
  });

  it("noteUnauthorized is a no-op without a session", () => {
    expect(() => noteUnauthorized()).not.toThrow();
  });

  it("identityJson throws IdentityError with the server's message", async () => {
    stubBasic((url) => {
      if (url === `${IDENTITY}/v1/broken`) {
        return jsonResponse({ error: "bad_request_code" }, 400);
      }
      return undefined;
    });
    await connectProvisional();
    const error = await identityJson("/v1/broken").catch((caught) => caught);
    expect(error).toBeInstanceOf(IdentityError);
    expect(overlapCast(error).message).toBe("bad_request_code");
    expect(overlapCast(error).status).toBe(400);
  });
});

describe("missing configuration", () => {
  beforeEach(() => {
    vi.stubGlobal("location", {
      hostname: "me.github.io",
      href: "https://me.github.io/OpenSesame/",
      origin: "https://me.github.io",
    });
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
  });

  it("mints a device-native provisional session when no remote Identity API is set", async () => {
    stubFetch(() => jsonResponse({}, 401));
    const session = await ensureIdentitySession();
    expect(session.principalId).toMatch(/^prn_/);
    expect(session.accessToken.length).toBeGreaterThan(8);
    expect(session.issuerOrigin.length).toBeGreaterThan(0);
  });

  it("connects provisionally against the device identity host", async () => {
    stubFetch(() => jsonResponse({}, 401));
    const session = await connectProvisional();
    expect(session.principalId).toMatch(/^prn_/);
  });

  it("reports device identity as reachable without fetching", async () => {
    const spy = stubFetch(() => jsonResponse({}, 500));
    await expect(probeIdentity()).resolves.toBe("reachable");
    expect(spy).not.toHaveBeenCalled();
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
