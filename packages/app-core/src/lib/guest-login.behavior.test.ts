import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Behaviour: a person can enter as a guest, skip registered auth, and still
 * be asked to claim the session later.
 *
 * Given/When/Then without a second framework — same decision as
 * packages/control-plane ceremony journeys.
 */

import {
  claimGuestAuth,
  continueAsGuest,
  guestAuthDependencies,
  linkGuestAccount,
} from "./guest-auth.js";
import { clearNotices, listNotices } from "./notices.js";

describe("guest login journey", () => {
  beforeEach(() => {
    clearNotices();
    const guest = {
      principalId: "prn_guest",
      accessToken: "guest-tok",
      issuerOrigin: "http://127.0.0.1:18788",
    };
    let active: typeof guest | null = null;
    guestAuthDependencies.createGuest = vi.fn().mockResolvedValue(undefined);
    guestAuthDependencies.isRemoteIdentityConfigured = () => true;
    guestAuthDependencies.connectFreshProvisional = vi.fn(async () => {
      active = guest;
      return guest;
    });
    guestAuthDependencies.connectProvisional = vi.fn().mockResolvedValue(guest);
    guestAuthDependencies.identityJson = vi.fn().mockResolvedValue({
      principalId: "prn_guest",
      identity: { assurance: "verified" },
    });
    guestAuthDependencies.currentSession = () => active;
    guestAuthDependencies.loadFederationSession = () => null;
  });

  afterEach(() => {
    clearNotices();
  });

  it("Given a first-run device, When they continue as guest, Then the vault opens and a claim notice waits", async () => {
    // Given — an empty device with Identity able to mint a provisional principal.
    expect(listNotices()).toEqual([]);

    // When — they elect not to sign in with registered auth.
    await continueAsGuest();

    // Then — they have a guest vault and a claim ceremony to attach auth later.
    expect(guestAuthDependencies.createGuest).toHaveBeenCalledTimes(1);
    const notice = listNotices()[0];
    expect(notice?.kind).toBe("guest_claim");
    expect(notice?.title).toMatch(/Claim this guest session/);
  });

  it("does not request another claim while one is waiting", async () => {
    await continueAsGuest();
    vi.mocked(guestAuthDependencies.connectProvisional).mockClear();

    await claimGuestAuth();

    expect(guestAuthDependencies.createGuest).toHaveBeenCalledTimes(1);
    expect(guestAuthDependencies.connectProvisional).not.toHaveBeenCalled();
    expect(listNotices()).toHaveLength(1);
  });

  it("Given a guest notice, When they return from registered sign-in, Then the id_token claims this principal", async () => {
    await continueAsGuest();
    vi.mocked(guestAuthDependencies.identityJson).mockClear();
    vi.mocked(guestAuthDependencies.identityJson).mockResolvedValue({
      principalId: "prn_guest",
      identity: { assurance: "verified" },
    });

    await linkGuestAccount("id.token.from.upstream");

    expect(guestAuthDependencies.identityJson).toHaveBeenCalledWith(
      "/v1/principals/link-identities",
      expect.objectContaining({
        body: JSON.stringify({ idToken: "id.token.from.upstream" }),
      }),
    );
    expect(listNotices()).toEqual([]);
  });
});
