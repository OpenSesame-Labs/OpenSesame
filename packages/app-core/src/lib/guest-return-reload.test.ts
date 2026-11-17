/** @vitest-environment jsdom */
import { overlapCast } from "@opensesame/os-domain";
import { expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
import { makeOpfs } from "./duress/wipe/fake-opfs.test-support.js";
import { saveGuestContinuation } from "./guest-continuation.js";
import { issueGuestReturn } from "./guest-return-record.js";
import { settleGuestReturnSignOut } from "./guest-return-signout.js";
import { newGuestVaultId } from "./guest-vault-id.js";
import { signOut } from "./session-exit.js";
import { acquireExclusiveGuestLease } from "./vault/vault-shared-locks.js";

it("finishes a persisted guest sign-out after the signing-out document reloads", async () => {
  localStorage.clear();
  sessionStorage.clear();
  const root = makeOpfs();
  configureHost(
    createTestHost({
      locks: webLocksDouble(),
      originFiles: async () => overlapCast(root),
    }),
  );
  const value = {
    kind: "vercel" as const,
    token: crypto.randomUUID(),
    connectionId: "connection",
    tomb: newGuestVaultId(),
    person: { id: "old-guest", name: "Guest" },
    origin: "https://app.example",
    pathname: "/connections",
    deadline: Date.now() + 60_000,
    identity: null,
  };
  await issueGuestReturn(value, () => {});
  saveGuestContinuation(value);
  const release = await acquireExclusiveGuestLease(value.tomb, true);
  signOut();
  await expect(settleGuestReturnSignOut()).rejects.toThrow();
  await release();
  vi.resetModules();
  const reloaded = await import("./guest-return-signout.js");
  await expect(reloaded.settleGuestReturnSignOut()).resolves.toBeUndefined();
  expect(
    [...Array(localStorage.length).keys()].some((index) =>
      localStorage.key(index)?.startsWith("opensesame.guest.signout-barrier."),
    ),
  ).toBe(false);
});
