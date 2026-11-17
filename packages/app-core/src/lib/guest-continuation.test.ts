/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost, host } from "../host.js";
import { createTestHost } from "../test-host.js";
import { atRestBinding, sealAtRest } from "./at-rest/cipher.js";
import { sealLegacyWebStorage } from "./at-rest/web-storage.js";
import {
  forgetGuestContinuation,
  inspectStoredGuestContinuation,
  peekGuestContinuation,
  saveGuestContinuation,
} from "./guest-continuation.js";
import { newGuestVaultId } from "./guest-vault-id.js";

beforeEach(() => {
  configureHost(createTestHost());
  window.history.replaceState(
    {},
    "",
    "/connections?connection=slack&guest_return=nonce-one",
  );
});
afterEach(() => {
  forgetGuestContinuation();
  vi.useRealTimers();
});

it("accepts only the original provider return in the initiating tab", () => {
  saveGuestContinuation({
    kind: "vercel",
    token: "nonce-one",
    connectionId: "slack",
    tomb: newGuestVaultId(),
    person: { id: `local_${crypto.randomUUID()}`, name: "guest-1" },
    origin: window.location.origin,
    pathname: "/connections",
    deadline: Date.now() + 60_000,
    identity: null,
  });
  expect(peekGuestContinuation()?.connectionId).toBe("slack");
  window.history.replaceState(
    {},
    "",
    "/connections?connection=other&guest_return=nonce-one",
  );
  expect(peekGuestContinuation()).toBeNull();
  window.history.replaceState(
    {},
    "",
    "/connections?connection=slack&guest_return=wrong",
  );
  expect(peekGuestContinuation()).toBeNull();
  window.history.replaceState(
    {},
    "",
    "/other?connection=slack&guest_return=nonce-one",
  );
  expect(peekGuestContinuation()).toBeNull();
  window.history.replaceState(
    {},
    "",
    "/connections?connection=slack&guest_return=nonce-one",
  );
  vi.setSystemTime(Date.now() + 61_000);
  expect(peekGuestContinuation()).toBeNull();
});

it("requires the matching GitHub state and returned code", () => {
  saveGuestContinuation({
    kind: "github",
    token: "state-one",
    tomb: newGuestVaultId(),
    person: { id: `local_${crypto.randomUUID()}`, name: "guest-2" },
    origin: window.location.origin,
    pathname: "/connections",
    deadline: Date.now() + 60_000,
    identity: null,
  });
  window.history.replaceState(
    {},
    "",
    "/connections?github_app=claim&state=state-one",
  );
  expect(peekGuestContinuation()).toBeNull();
  window.history.replaceState(
    {},
    "",
    "/connections?github_app=claim&state=state-one&code=one-use",
  );
  expect(peekGuestContinuation()?.kind).toBe("github");
  forgetGuestContinuation();
  expect(peekGuestContinuation()).toBeNull();
});

it("does not treat a sealed continuation under an unavailable key as absent", () => {
  const key = "opensesame.guest.provider-return.v1";
  const foreignKey = crypto.getRandomValues(new Uint8Array(32));
  sessionStorage.setItem(
    key,
    sealAtRest(foreignKey, atRestBinding("web-storage.session", key), "{}"),
  );
  expect(inspectStoredGuestContinuation()).toEqual({ kind: "unavailable" });
  expect(sessionStorage.getItem(key)).not.toBeNull();
});

it("retains a corrupt physical continuation for sign-out recovery", () => {
  const key = "opensesame.guest.provider-return.v1";
  sessionStorage.setItem(key, "corrupt");
  sealLegacyWebStorage("session");
  expect(inspectStoredGuestContinuation()).toEqual({ kind: "unavailable" });
  expect(sessionStorage.getItem(key)).toBe("corrupt");
});

it("does not fail the boot sweep when session storage is blocked", () => {
  const original = host();
  configureHost(
    createTestHost({
      storage: {
        get session(): never {
          throw new DOMException("blocked", "SecurityError");
        },
      },
    }),
  );
  try {
    expect(sealLegacyWebStorage("session")).toBe(0);
  } finally {
    configureHost(original);
  }
});
