/** @vitest-environment jsdom */
/**
 * A fresh guest must never act under an account already on this device: an
 * approved Host grant, or an Identity cookie another tab left that still
 * authenticates without a bearer here (AUTH-C1).
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  FRESH_GUEST_SIGN_OUT_MESSAGE,
  continueAsGuest,
  guestAuthDependencies,
  resumeGuestSession,
} from "./guest-auth.js";
import { clearGuestSessionPerson } from "./local-guest.js";

const createGuest = vi.fn();
const mintGuestPerson = vi.fn();
const original = { ...guestAuthDependencies };

beforeEach(() => {
  clearGuestSessionPerson();
  createGuest.mockReset().mockResolvedValue(undefined);
  mintGuestPerson.mockReset().mockResolvedValue(undefined);
  Object.assign(guestAuthDependencies, {
    createGuest,
    mintGuestPerson,
    isRemoteIdentityConfigured: () => false,
    currentSession: () => null,
    loadFederationSession: () => null,
    hasHostSession: () => false,
    hasHiddenIdentitySession: () => false,
  });
});

afterEach(() => {
  Object.assign(guestAuthDependencies, original);
  clearGuestSessionPerson();
});

it("refuses a fresh guest while this device holds an approved Host grant", async () => {
  guestAuthDependencies.hasHostSession = () => true;
  await expect(continueAsGuest()).rejects.toThrow(FRESH_GUEST_SIGN_OUT_MESSAGE);
  expect(createGuest).not.toHaveBeenCalled();
});

it("refuses a fresh guest while a hidden Identity session still authenticates", async () => {
  guestAuthDependencies.hasHiddenIdentitySession = () => true;
  await expect(continueAsGuest()).rejects.toThrow(FRESH_GUEST_SIGN_OUT_MESSAGE);
  await expect(resumeGuestSession()).rejects.toThrow(
    FRESH_GUEST_SIGN_OUT_MESSAGE,
  );
  expect(createGuest).not.toHaveBeenCalled();
});

it("refuses when a Host grant lands while the guest person is minted", async () => {
  mintGuestPerson.mockImplementation(async (validate?: () => void) => {
    guestAuthDependencies.hasHostSession = () => true;
    validate?.();
  });
  await expect(continueAsGuest()).rejects.toThrow(FRESH_GUEST_SIGN_OUT_MESSAGE);
  expect(createGuest).not.toHaveBeenCalled();
});

it("still opens a fresh guest with no account on the device", async () => {
  await continueAsGuest();
  expect(createGuest).toHaveBeenCalledWith({ resume: false });
});
