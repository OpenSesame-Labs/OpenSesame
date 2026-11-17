/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it } from "vitest";
import { configureHost } from "../host.js";
import { localStore } from "../ports.js";
import { createTestHost } from "../test-host.js";
import { isSealedAtRest } from "./at-rest/cipher.js";
import { sealLegacyWebStorage } from "./at-rest/web-storage.js";
import {
  advanceGuestReturnEpoch,
  assertGuestReturnEpoch,
  captureGuestReturnEpoch,
  readGuestReturnEpoch,
  requireGuestReturnEpoch,
} from "./guest-return-epoch.js";
import { GUEST_RETURN_EPOCH_KEY } from "./guest-return-epoch-key.js";
import {
  haltStorageWrites,
  resumeStorageWritesForTest,
} from "./storage-halt.js";

beforeEach(() => {
  configureHost(createTestHost());
  localStorage.clear();
});
afterEach(resumeStorageWritesForTest);

it("seals the epoch and rejects the previous value after sign-out", () => {
  const first = requireGuestReturnEpoch();
  expect(
    isSealedAtRest(localStorage.getItem(GUEST_RETURN_EPOCH_KEY) ?? ""),
  ).toBe(true);
  expect(requireGuestReturnEpoch()).toBe(first);
  const next = advanceGuestReturnEpoch();
  expect(next).not.toBe(first);
  expect(() => assertGuestReturnEpoch(first)).toThrow();
  expect(() => assertGuestReturnEpoch(next)).not.toThrow();
});

it("preserves an unsealed or corrupt epoch instead of silently resetting it", () => {
  localStorage.setItem(GUEST_RETURN_EPOCH_KEY, "untrusted");
  sealLegacyWebStorage("local");
  expect(localStorage.getItem(GUEST_RETURN_EPOCH_KEY)).toBe("untrusted");
  expect(captureGuestReturnEpoch()).toBeNull();
  expect(() => advanceGuestReturnEpoch()).toThrow();
  localStore().setItem(GUEST_RETURN_EPOCH_KEY, "not-a-valid-epoch");
  expect(() => readGuestReturnEpoch()).toThrow();
});

it("does not report a successful sign-out when the physical write is halted", () => {
  const first = requireGuestReturnEpoch();
  haltStorageWrites();
  expect(() => advanceGuestReturnEpoch()).toThrow();
  expect(readGuestReturnEpoch()).toBe(first);
});

it("never treats an evicted epoch as matching a previously issued value", () => {
  const first = requireGuestReturnEpoch();
  localStorage.removeItem(GUEST_RETURN_EPOCH_KEY);
  expect(() => assertGuestReturnEpoch(first)).toThrow();
  expect(requireGuestReturnEpoch()).not.toBe(first);
});
