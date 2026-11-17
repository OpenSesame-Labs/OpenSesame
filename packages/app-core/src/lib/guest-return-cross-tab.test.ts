/** @vitest-environment jsdom */
import { overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
import { makeOpfs } from "./duress/wipe/fake-opfs.test-support.js";
import type { GuestContinuation } from "./guest-continuation.js";
import { consumeGuestReturn, issueGuestReturn } from "./guest-return-record.js";
import { newGuestVaultId } from "./guest-vault-id.js";
import { kvForgetAll, kvSeams } from "./kv.js";
import { signOut } from "./session-exit.js";

let value: GuestContinuation;
beforeEach(() => {
  const root = makeOpfs();
  configureHost(
    createTestHost({
      locks: webLocksDouble(),
      originFiles: async () => overlapCast(root),
    }),
  );
  sessionStorage.clear();
  localStorage.clear();
  value = {
    kind: "vercel",
    token: crypto.randomUUID(),
    connectionId: "connection",
    tomb: newGuestVaultId(),
    person: { id: "old-guest", name: "Guest" },
    origin: "https://app.example",
    pathname: "/connections",
    deadline: Date.now() + 60_000,
    identity: null,
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  kvForgetAll();
  configureHost(createTestHost());
});

it("invalidates an issued return even when sign-out cannot see the other tab's continuation", async () => {
  await issueGuestReturn(value, () => {});
  signOut();
  await expect(consumeGuestReturn(value, () => {})).rejects.toThrow();
});

it("does not publish a guest return whose write began before another tab signed out", async () => {
  let release = () => {};
  let started = () => {};
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = kvSeams.kvSetDurable;
  vi.spyOn(kvSeams, "kvSetDurable").mockImplementation(
    async (key, data, check) => {
      if (key === `guest-provider-return/${value.tomb}`) {
        started();
        await gate;
      }
      return original(key, data, check);
    },
  );
  const writing = issueGuestReturn(value, () => {});
  await begun;
  signOut();
  release();
  await expect(writing).rejects.toThrow();
  await expect(consumeGuestReturn(value, () => {})).rejects.toThrow();
});
