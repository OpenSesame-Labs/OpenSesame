/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createMemoryStorage } from "../memory-storage.js";
import { createTestHost } from "../test-host.js";
import { deviceIdentitySeams } from "./device-identity.js";
import { identitySeams } from "./identity.js";
import {
  beginMagicLink,
  completeMagicLink,
  completeMagicLinkIfPresent,
} from "./magic-link-client.js";

const base = "https://identity.example.test";
const originalRemote = deviceIdentitySeams.remoteIdentityApi;
const originalRestore = identitySeams.restoreSession;

beforeEach(() => {
  configureHost(
    createTestHost({
      page: window,
      storage: { session: createMemoryStorage() },
    }),
  );
  deviceIdentitySeams.remoteIdentityApi = () => base;
});

afterEach(() => {
  deviceIdentitySeams.remoteIdentityApi = originalRemote;
  identitySeams.restoreSession = originalRestore;
  vi.unstubAllGlobals();
});

it("keeps the verifier tab-local and adopts only a matching callback", async () => {
  const request = await beginMagicLink("ada@example.test");
  const sent = JSON.parse(String(request.body));
  expect(sent.codeChallenge).not.toBe(sent.state);
  const restored = vi.fn();
  identitySeams.restoreSession = restored;
  const fetchMock = vi.fn(() =>
    Promise.resolve(
      Response.json({ principalId: "prn_person", accessToken: "pst_secret" }),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  await expect(
    completeMagicLink("code-once", `${sent.state}wrong`, () => undefined),
  ).rejects.toThrow(/did not match/u);
  expect(fetchMock).not.toHaveBeenCalled();

  const retried = await beginMagicLink("ada@example.test");
  const retryBody = JSON.parse(String(retried.body));
  const scrub = vi.fn();
  await expect(
    completeMagicLinkIfPresent(
      `?magic_code=code-once&magic_state=${retryBody.state}`,
      scrub,
      () => undefined,
    ),
  ).resolves.toBe(true);
  expect(scrub).toHaveBeenCalledOnce();
  const [, exchange] = fetchMock.mock.calls[0] ?? [];
  const exchangeBody = JSON.parse(String(exchange?.body));
  expect(exchangeBody).toMatchObject({
    code: "code-once",
    state: retryBody.state,
  });
  expect(exchangeBody.codeVerifier).not.toBe(retryBody.codeChallenge);
  expect(restored).toHaveBeenCalledWith(
    expect.objectContaining({
      principalId: "prn_person",
      accessToken: "pst_secret",
      issuerOrigin: base,
    }),
    expect.any(Number),
  );
  await expect(
    completeMagicLink("code-once", retryBody.state, () => undefined),
  ).rejects.toThrow(/did not match/u);
});
