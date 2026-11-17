import { overlapCast } from "@opensesame/os-domain";
import { afterEach, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { deviceIdentitySeams } from "./device-identity.js";
import { inspectCookieBinding } from "./identity-cookie-binding.js";
import { captureIdentityEpoch } from "./identity-owner-epoch.js";
import { hasPendingBoundRevocation } from "./identity-revocation-journal.js";

afterEach(() => {
  vi.restoreAllMocks();
  configureHost(createTestHost());
});

it("treats missing page storage as unavailable even without a DOM global", () => {
  expect(typeof document).toBe("undefined");
  vi.spyOn(deviceIdentitySeams, "remoteIdentityApi").mockReturnValue(
    "https://identity.example",
  );
  configureHost(createTestHost({ page: overlapCast({}), storage: {} }));

  expect(inspectCookieBinding("https://identity.example")).toEqual({
    kind: "unavailable",
  });
  expect(() => hasPendingBoundRevocation()).toThrow(/storage is unavailable/i);
  expect(() => captureIdentityEpoch()).toThrow(/check browser storage/i);
});

it("allows a host with no page to run without shared browser storage", () => {
  vi.spyOn(deviceIdentitySeams, "remoteIdentityApi").mockReturnValue(
    "https://identity.example",
  );
  configureHost(createTestHost({ page: undefined, storage: {} }));

  expect(inspectCookieBinding("https://identity.example")).toEqual({
    kind: "none",
  });
  expect(hasPendingBoundRevocation()).toBe(false);
  expect(captureIdentityEpoch()).toBeNull();
});
