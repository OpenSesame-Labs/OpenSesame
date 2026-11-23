/** @vitest-environment jsdom */
import { type Server, createServer } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  IDENTITY,
  jsonResponse,
  stubBasic,
  stubFetch,
} from "./__tests__/identity-session-support.js";
import {
  freshSignOutBrowser,
  journalKeys,
  restoreSignOutBrowser,
} from "./__tests__/identity-signout-support.js";
import { loopbackProfileEligible } from "./__tests__/loopback-profile.js";
import {
  connectProvisional,
  currentSession,
  endSession,
  identityFetch,
  settleRevokes,
} from "./identity.js";
import { stageRevocation } from "./identity-revocation-journal.js";
import { localNetworkFetchSeams } from "./local-network-fetch.js";
import { loadSettings, saveSettings } from "./settings.js";

const ME = `${IDENTITY}/v1/principals/me`;
const REVOKE = `${IDENTITY}/v1/principals/provisional/revoke`;

beforeEach(() => freshSignOutBrowser());
afterEach(() => {
  vi.unstubAllGlobals();
  restoreSignOutBrowser();
});

/** A cookie that still authenticates, behind a revoke the service refuses. */
function refusingRevoke(calls: string[] = []) {
  return stubFetch((url) => {
    calls.push(url);
    if (url === REVOKE) return jsonResponse({}, 503);
    if (url === ME) return jsonResponse({ id: "principal_1" });
    return jsonResponse({}, 500);
  });
}

async function reloadIdentity() {
  vi.resetModules();
  const network = await import("./local-network-fetch.js");
  network.localNetworkFetchSeams.eligible = loopbackProfileEligible;
  // Settings live in this document's memory; the next one reads them afresh.
  const settings = await import("./settings.js");
  settings.saveSettings({ ...settings.loadSettings(), identityApi: IDENTITY });
  return import("./identity.js");
}

it("seals an owed cookie revoke and never resumes that cookie after a reload", async () => {
  stubBasic();
  await connectProvisional();
  refusingRevoke();
  endSession();
  await settleRevokes();
  const [key] = journalKeys();
  expect(key).toBeTruthy();
  const raw = localStorage.getItem(key ?? "") ?? "";
  expect(raw).toMatch(/^osr2\./u);
  expect(raw).not.toContain(IDENTITY);
  expect(raw).not.toContain("identity_tok");

  const reloaded = await reloadIdentity();
  const calls: string[] = [];
  refusingRevoke(calls);
  await expect(reloaded.connectProvisional()).rejects.toThrow(
    /sign-out did not finish/i,
  );
  expect(calls).toContain(REVOKE);
  expect(calls).not.toContain(ME);
  expect(reloaded.currentSession()).toBeNull();
  await expect(reloaded.settleSignOut()).rejects.toThrow(/did not finish/i);

  const finished = stubBasic();
  await reloaded.settleSignOut();
  expect(journalKeys()).toEqual([]);
  const revoke = finished.mock.calls.find(([url]) => String(url) === REVOKE);
  expect(revoke?.[1]?.credentials).toBe("include");
  await expect(reloaded.connectProvisional()).resolves.toMatchObject({
    accessToken: "identity_tok",
  });
});

it("sends a saved revoke once when two documents recover together", async () => {
  stageRevocation(IDENTITY);
  let release = () => {};
  let started = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  const requests = stubFetch(async (url) => {
    if (url !== REVOKE) return jsonResponse({}, 500);
    started();
    await gate;
    return new Response(null, { status: 204 });
  });
  const first = await reloadIdentity();
  const firstWork = first.settleSignOut();
  await begun;
  const second = await reloadIdentity();
  const secondWork = second.settleSignOut();
  release();
  await Promise.all([firstWork, secondWork]);
  expect(requests).toHaveBeenCalledTimes(1);
  expect(journalKeys()).toEqual([]);
});

it("keeps the cookie revoke owed in session-only mode instead of minting beside it", async () => {
  freshSignOutBrowser({ atRestKeys: undefined });
  stubBasic();
  await connectProvisional();
  refusingRevoke();
  endSession();
  await settleRevokes();
  // Nothing is written without a durable key, yet this tab stays fenced.
  expect(journalKeys()).toEqual([]);
  expect(localStorage.length).toBe(0);
  await expect(connectProvisional()).rejects.toThrow(
    /sign-out did not finish/i,
  );
  expect(currentSession()).toBeNull();
});

it("lets no cookie answer an Identity request while a sign-out is owed", async () => {
  stageRevocation(IDENTITY);
  const fetcher = stubBasic();
  await expect(identityFetch("/v1/principals/me")).rejects.toThrow(
    /finish signing out/i,
  );
  expect(fetcher).not.toHaveBeenCalled();
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = z.object({ port: z.number() }).parse(server.address());
  return `http://127.0.0.1:${port}`;
}

it("keeps the revoke owed when Identity redirects it to another origin", async () => {
  let received = 0;
  const other = createServer((_request, response) => {
    received += 1;
    response.writeHead(204).end();
  });
  const otherOrigin = await listen(other);
  const identity = createServer((_request, response) => {
    response.writeHead(307, { location: `${otherOrigin}/capture` }).end();
  });
  const issuer = await listen(identity);
  const eligible = localNetworkFetchSeams.eligible;
  try {
    localNetworkFetchSeams.eligible = () => true;
    saveSettings({ ...loadSettings(), identityApi: issuer });
    endSession({ signOut: true });
    await settleRevokes();
    expect(received).toBe(0);
    expect(journalKeys()).toHaveLength(1);
  } finally {
    localNetworkFetchSeams.eligible = eligible;
    identity.closeAllConnections();
    other.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => identity.close(() => resolve())),
      new Promise<void>((resolve) => other.close(() => resolve())),
    ]);
  }
});
