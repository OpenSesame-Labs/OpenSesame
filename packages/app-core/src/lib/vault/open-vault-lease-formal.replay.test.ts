import { describe, expect, it } from "vitest";
import {
  VaultStoreConflictError,
  acquireOpenLease,
  forgetOpenLeasesForTest,
  withExclusiveOpenLease,
} from "./vault-shared-locks.js";

/**
 * Shortest TLC path: open, forget, open again, stale release, exclusive blocked,
 * current release, exclusive ok (`OpenVaultLease.tla`: AfterForgetAcquire).
 */
describe("open vault lease formal replay", () => {
  it("does not let a stale release clear a new generation's open count", async () => {
    forgetOpenLeasesForTest();
    const staleRelease = await acquireOpenLease("personal");
    forgetOpenLeasesForTest();
    const currentRelease = await acquireOpenLease("personal");

    await staleRelease();

    await expect(
      withExclusiveOpenLease("personal", async () => "destroyed"),
    ).rejects.toBeInstanceOf(VaultStoreConflictError);

    await expect(
      withExclusiveOpenLease("personal", async () => "destroyed-again"),
    ).rejects.toBeInstanceOf(VaultStoreConflictError);

    await currentRelease();

    await expect(
      withExclusiveOpenLease("personal", async () => "ok"),
    ).resolves.toBe("ok");
  });
});
