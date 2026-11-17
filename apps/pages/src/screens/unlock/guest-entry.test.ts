import { guestAuthSeams } from "@opensesame/app-core/lib/guest-auth.js";
import { afterEach, expect, it, vi } from "vitest";
import {
  clearNewGuestLanding,
  takeNewGuestLanding,
} from "../../lib/guest-landing.js";
import { startGuestSession } from "./guest-entry.js";

afterEach(() => {
  clearNewGuestLanding();
  vi.restoreAllMocks();
});

it("marks a new guest landing before opening the vault", async () => {
  vi.spyOn(guestAuthSeams, "continueAsGuest").mockImplementation(async () => {
    expect(takeNewGuestLanding()).toBe(true);
  });
  await startGuestSession();
});

it("clears the landing if guest entry fails", async () => {
  vi.spyOn(guestAuthSeams, "continueAsGuest").mockRejectedValueOnce(
    new Error("Guest unavailable"),
  );
  await expect(startGuestSession()).rejects.toThrow("Guest unavailable");
  expect(takeNewGuestLanding()).toBe(false);
});
