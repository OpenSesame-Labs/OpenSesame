/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
import {
  connectProvisional,
  currentSession,
  settleRevokes,
  settleSignOut,
} from "./identity.js";
import { clearNotices, listNotices } from "./notices.js";
import { signOut } from "./session-exit.js";

const REVOKE = `${IDENTITY}/v1/principals/provisional/revoke`;
const incomplete = () =>
  listNotices().some((notice) => notice.id === "session.signout-incomplete");

beforeEach(() => {
  freshSignOutBrowser();
  clearNotices();
});
afterEach(async () => {
  await settleRevokes();
  clearNotices();
  vi.unstubAllGlobals();
  restoreSignOutBrowser();
});

it("says sign-out is incomplete until Identity confirms the revoke, then retries it", async () => {
  stubBasic();
  await connectProvisional();
  let available = false;
  const fetcher = stubFetch((url) => {
    if (url === REVOKE) return jsonResponse({}, available ? 200 : 503);
    if (url.endsWith("/v1/principals/me")) return jsonResponse({}, 401);
    return jsonResponse({}, 500);
  });
  signOut();
  expect(currentSession()).toBeNull();
  await vi.waitFor(() => expect(incomplete()).toBe(true));
  expect(journalKeys()).toHaveLength(1);
  await expect(connectProvisional()).rejects.toThrow(/did not finish/i);

  available = true;
  signOut();
  expect(incomplete()).toBe(false);
  await settleSignOut();
  expect(incomplete()).toBe(false);
  expect(journalKeys()).toEqual([]);
  const revokes = fetcher.mock.calls.filter(([url]) => String(url) === REVOKE);
  expect(revokes.at(-1)?.[1]?.credentials).toBe("include");
});
