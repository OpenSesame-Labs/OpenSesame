/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createMemoryStorage } from "../memory-storage.js";
import { createTestHost } from "../test-host.js";

const base = "https://identity.example.test";

type Modules = {
  device: typeof import("./device-identity.js");
  identity: typeof import("./identity.js");
  proof: typeof import("./identity-token-proof.js");
  magic: typeof import("./magic-link-client.js");
};

/** A fresh page load: every module, and so the session epoch, starts over. */
async function load(): Promise<Modules> {
  vi.resetModules();
  const device = await import("./device-identity.js");
  device.deviceIdentitySeams.remoteIdentityApi = () => base;
  return {
    device,
    identity: await import("./identity.js"),
    proof: await import("./identity-token-proof.js"),
    magic: await import("./magic-link-client.js"),
  };
}

function stubExchange(onExchange: () => void = () => undefined): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      onExchange();
      return Response.json({
        principalId: "prn_member",
        accessToken: "pst_member",
      });
    }),
  );
}

/** Ask for a link after this page load has moved its epoch past zero. */
async function requestLink(page: Modules): Promise<string> {
  page.identity.clearSession();
  page.identity.clearSession();
  expect(page.identity.identitySessionEpoch()).toBe(2);
  const handoff = await page.magic.beginMagicLink("ada@example.test");
  handoff.commit();
  return JSON.parse(String(handoff.request.body)).state;
}

beforeEach(() => {
  configureHost(
    createTestHost({ storage: { session: createMemoryStorage() } }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("adopts a valid email-link return after the link reloads the app", async () => {
  const state = await requestLink(await load());
  const returned = await load();
  expect(returned.identity.identitySessionEpoch()).toBe(0);
  stubExchange();
  await expect(
    returned.magic.completeMagicLink("code", state, () => undefined),
  ).resolves.toBe(true);
  expect(returned.identity.currentSession()).toMatchObject({
    principalId: "prn_member",
    accessToken: "pst_member",
  });
  expect(returned.proof.hasPendingBearerRevokes(base)).toBe(false);
});

it("still refuses a reloaded return when a sign-out lands during the exchange", async () => {
  const state = await requestLink(await load());
  const returned = await load();
  stubExchange(() => returned.identity.clearSession());
  await expect(
    returned.magic.completeMagicLink("code", state, () => undefined),
  ).rejects.toThrow(/ended while finishing sign-in/u);
  expect(returned.identity.currentSession()).toBeNull();
});

it("still refuses a same-load return after a sign-out since the request", async () => {
  const page = await load();
  const state = await requestLink(page);
  page.identity.clearSession();
  stubExchange();
  await expect(
    page.magic.completeMagicLink("code", state, () => undefined),
  ).rejects.toThrow(/ended while finishing sign-in/u);
  expect(page.identity.currentSession()).toBeNull();
});
