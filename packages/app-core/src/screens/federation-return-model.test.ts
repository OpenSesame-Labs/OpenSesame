/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { clearAuthOutcome, readAuthOutcome } from "../lib/auth-outcome.js";
import { deviceIdentitySeams } from "../lib/device-identity.js";
import { completeSignIn } from "../lib/federation.js";
import { guestAuthSeams } from "../lib/guest-auth.js";
import { clearSession, currentSession } from "../lib/identity.js";
import { beginMagicLink } from "../lib/magic-link-client.js";
import { createMemoryStorage } from "../memory-storage.js";
import { createTestHost } from "../test-host.js";
import { processReturn } from "./federation-return-model.js";

const base = "https://identity.example.test";
const originalRemote = deviceIdentitySeams.remoteIdentityApi;
const originalOpenVault = guestAuthSeams.openVaultAfterSignIn;

/** Request a link in this tab, then arrive on the address it sends back. */
async function arriveFromEmailLink(): Promise<void> {
  const handoff = await beginMagicLink("ada@example.test");
  handoff.commit();
  const { state } = JSON.parse(String(handoff.request.body));
  history.replaceState(null, "", `/?magic_code=code-1&magic_state=${state}`);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ principalId: "prn_member", accessToken: "pst_member" }),
    ),
  );
}

beforeEach(() => {
  configureHost(
    createTestHost({ storage: { session: createMemoryStorage() } }),
  );
  deviceIdentitySeams.remoteIdentityApi = () => base;
  clearAuthOutcome();
});

afterEach(() => {
  deviceIdentitySeams.remoteIdentityApi = originalRemote;
  guestAuthSeams.openVaultAfterSignIn = originalOpenVault;
  clearSession();
  history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

it("opens the vault after a first-run email-link sign-in", async () => {
  await arriveFromEmailLink();
  const openVault = vi.fn(async () => true);
  guestAuthSeams.openVaultAfterSignIn = openVault;
  await expect(processReturn()).resolves.toEqual({});
  expect(openVault).toHaveBeenCalledOnce();
  expect(currentSession()).toMatchObject({ principalId: "prn_member" });
  expect(location.search).toBe("");
  // Inside the app, the bell owns anything further: no stale banner.
  expect(readAuthOutcome()).toBeNull();
});

it("records the sign-in for the unlock screen when the vault stays locked", async () => {
  await arriveFromEmailLink();
  guestAuthSeams.openVaultAfterSignIn = vi.fn(async () => false);
  await expect(processReturn()).resolves.toEqual({});
  expect(readAuthOutcome()).toEqual({ kind: "authenticated" });
});

it("keeps completeSignIn null for an email-link return", async () => {
  await arriveFromEmailLink();
  await expect(completeSignIn()).resolves.toBeNull();
  expect(currentSession()).toMatchObject({ principalId: "prn_member" });
});
