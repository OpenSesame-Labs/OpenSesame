/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
import { endSession, settleRevokes } from "./identity.js";
import { saveCookieBinding } from "./identity-cookie-binding.js";
import { IDENTITY_REVOCATION_PREFIX } from "./identity-revocation-key.js";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

it("finishes a sealed proof-based revocation after a reload", async () => {
  localStorage.clear();
  sessionStorage.clear();
  const issuer = "https://identity.example";
  configureHost(
    createTestHost({
      env: { VITE_IDENTITY_API: issuer },
      locks: webLocksDouble(),
    }),
  );
  const binding = {
    issuerOrigin: issuer,
    principalId: "old-principal",
    sessionId: "ps_old",
    proof: "a".repeat(64),
  };
  expect(saveCookieBinding(binding)).toBe(true);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 503 })),
  );
  endSession();
  await expect(settleRevokes()).rejects.toThrow(/sign-out did not finish/i);
  const key = [...Array(localStorage.length).keys()]
    .map((index) => localStorage.key(index))
    .find((name) => name?.startsWith(IDENTITY_REVOCATION_PREFIX));
  expect(key).toBeTruthy();
  expect(localStorage.getItem(key ?? "")).toMatch(/^osr2\./u);
  expect(localStorage.getItem(key ?? "")).not.toContain(binding.proof);

  vi.resetModules();
  const reloaded = await import("./identity.js");
  const requests = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(null, { status: 204 }),
  );
  vi.stubGlobal("fetch", requests);
  expect(reloaded.identitySeams.identityBase()).toBe(issuer);
  const transport = await import("./identity-cookie-transport.js");
  expect((await transport.revokeBoundCookie(binding)).status).toBe(204);
  requests.mockClear();
  await reloaded.settleRevokes();
  const headers = new Headers(requests.mock.calls[0]?.[1]?.headers);
  expect(headers.get("x-opensesame-revoke-session")).toBe(binding.sessionId);
  expect(headers.get("x-opensesame-revoke-secret")).toBe(binding.proof);
  expect(localStorage.getItem(key ?? "")).toBeNull();
});

it("serializes recovery from two documents and sends the saved proof once", async () => {
  localStorage.clear();
  sessionStorage.clear();
  const issuer = "https://identity.example";
  configureHost(
    createTestHost({
      env: { VITE_IDENTITY_API: issuer },
      locks: webLocksDouble(),
    }),
  );
  const journal = await import("./identity-revocation-journal.js");
  journal.stageBoundRevocation(
    {
      issuerOrigin: issuer,
      principalId: "old-principal",
      sessionId: "ps_old",
      proof: "b".repeat(64),
    },
    false,
  );
  let release = () => {};
  let started = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  const requests = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) => {
      started();
      await gate;
      return new Response(null, { status: 204 });
    },
  );
  vi.stubGlobal("fetch", requests);
  vi.resetModules();
  const first = await import("./identity.js");
  const firstWork = first.settleRevokes();
  await begun;
  vi.resetModules();
  const second = await import("./identity.js");
  const secondWork = second.settleRevokes();
  release();
  await Promise.all([firstWork, secondWork]);
  expect(requests).toHaveBeenCalledTimes(1);
  expect(journal.hasPendingBoundRevocation()).toBe(false);
});

it("does not sweep shared cookies when cross-tab locking is unavailable", async () => {
  localStorage.clear();
  sessionStorage.clear();
  const issuer = "https://identity.example";
  configureHost(
    createTestHost({ env: { VITE_IDENTITY_API: issuer }, locks: undefined }),
  );
  vi.resetModules();
  const journal = await import("./identity-revocation-journal.js");
  const entry = journal.stageBoundRevocation(
    {
      issuerOrigin: issuer,
      principalId: "old-principal",
      sessionId: "ps_old",
      proof: "c".repeat(64),
    },
    true,
  );
  const queued = await import("./identity-revocation-journal-queue.js");
  const { settleIdentityRevocations } = await import(
    "./identity-revocation-queue.js"
  );
  const requests = vi.fn();
  vi.stubGlobal("fetch", requests);
  queued.queueBoundRevocation(
    entry,
    () => issuer,
    async () => {},
  );
  await expect(settleIdentityRevocations()).rejects.toThrow(
    /sign-out did not finish/i,
  );
  expect(requests).not.toHaveBeenCalled();
  expect(journal.hasPendingBoundRevocation()).toBe(true);
});
