/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionStore } from "../ports.js";
import {
  FRESH_GUEST_SIGN_OUT_MESSAGE,
  FRESH_GUEST_STATUS_UNKNOWN_MESSAGE,
  adoptFederatedIdentity,
  continueAsGuest,
  guestAuthDependencies,
  linkGuestAccount,
  openVaultAfterSignIn,
  recoverPendingFederatedLink,
  resumeGuestSession,
} from "./guest-auth.js";
import { IdentityError } from "./identity.js";
import { clearGuestSessionPerson } from "./local-guest.js";
import { clearNotices, listNotices } from "./notices.js";

const connectProvisional = vi.fn();
const connectFreshProvisional = vi.fn();
const rebindSession = vi.fn();
const identityJson = vi.fn();
const currentSession = vi.fn();
const createGuest = vi.fn();
const vaultStatus = vi.fn();
const loadFederationSession = vi.fn();
const resumeSession = vi.fn();
const inspectRemoteSession = vi.fn();
const isRemoteIdentityConfigured = vi.fn(() => true);
const mintGuestPerson = guestAuthDependencies.mintGuestPerson;

Object.assign(guestAuthDependencies, {
  rebindSession,
  connectProvisional,
  connectFreshProvisional,
  isRemoteIdentityConfigured,
  identityJson,
  currentSession,
  createGuest,
  vaultStatus,
  loadFederationSession,
  resumeSession,
  inspectRemoteSession,
});

beforeEach(() => {
  guestAuthDependencies.mintGuestPerson = mintGuestPerson;
  clearNotices();
  sessionStorage.clear();
  connectProvisional.mockReset();
  connectFreshProvisional.mockReset();
  rebindSession.mockReset();
  rebindSession.mockResolvedValue(undefined);
  identityJson.mockReset();
  currentSession.mockReset();
  createGuest.mockReset();
  createGuest.mockResolvedValue(undefined);
  vaultStatus.mockReset();
  vaultStatus.mockReturnValue("unlocked");
  loadFederationSession.mockReset();
  loadFederationSession.mockReturnValue(null);
  resumeSession.mockReset();
  resumeSession.mockResolvedValue(null);
  inspectRemoteSession.mockReset();
  inspectRemoteSession.mockResolvedValue({ kind: "absent" });
  isRemoteIdentityConfigured.mockReset();
  isRemoteIdentityConfigured.mockReturnValue(true);
  connectProvisional.mockResolvedValue({
    principalId: "prn_guest",
    accessToken: "guest-tok",
    issuerOrigin: "http://127.0.0.1:18788",
  });
  connectFreshProvisional.mockImplementation(async () => {
    const inspected = await inspectRemoteSession();
    if (inspected.kind === "unknown") {
      throw new Error(FRESH_GUEST_STATUS_UNKNOWN_MESSAGE);
    }
    if (inspected.kind === "present" || currentSession()) {
      throw new Error(FRESH_GUEST_SIGN_OUT_MESSAGE);
    }
    return {
      principalId: "prn_guest",
      accessToken: "guest-tok",
      issuerOrigin: "http://127.0.0.1:18788",
    };
  });
  currentSession.mockReturnValue(null);
  identityJson.mockResolvedValue({
    principalId: "prn_guest",
    identity: { assurance: "verified" },
  });
});

afterEach(() => {
  clearNotices();
  sessionStorage.clear();
});

describe("continueAsGuest", () => {
  it("requires sign-out before replacing a live Identity session", async () => {
    currentSession.mockReturnValue({
      principalId: "prn_member",
      accessToken: "member-tok",
      issuerOrigin: "http://127.0.0.1:18788",
    });

    await expect(continueAsGuest()).rejects.toThrow(
      FRESH_GUEST_SIGN_OUT_MESSAGE,
    );
    expect(createGuest).not.toHaveBeenCalled();
    expect(connectProvisional).not.toHaveBeenCalled();
  });

  it("requires sign-out when an Identity cookie resumes after reload", async () => {
    inspectRemoteSession.mockResolvedValue({
      kind: "present",
      session: {
        principalId: "prn_member",
        accessToken: "cookie:prn_member",
        cookieOnly: true,
        issuerOrigin: "http://127.0.0.1:18788",
      },
    });

    await expect(continueAsGuest()).rejects.toThrow(
      FRESH_GUEST_SIGN_OUT_MESSAGE,
    );
    expect(createGuest).not.toHaveBeenCalled();
  });

  it("fails closed when the remote cookie status is unknown", async () => {
    inspectRemoteSession.mockResolvedValue({ kind: "unknown" });

    await expect(continueAsGuest()).rejects.toThrow(
      FRESH_GUEST_STATUS_UNKNOWN_MESSAGE,
    );
    expect(createGuest).not.toHaveBeenCalled();
    expect(connectProvisional).not.toHaveBeenCalled();
  });

  it("rechecks local session state after the remote probe", async () => {
    let finishProbe: (() => void) | undefined;
    inspectRemoteSession.mockReturnValue(
      new Promise((resolve) => {
        finishProbe = () => resolve({ kind: "absent" });
      }),
    );

    const opening = continueAsGuest();
    currentSession.mockReturnValue({
      principalId: "prn_member",
      accessToken: "member-tok",
      issuerOrigin: "http://127.0.0.1:18788",
    });
    finishProbe?.();

    await expect(opening).rejects.toThrow(FRESH_GUEST_SIGN_OUT_MESSAGE);
    expect(createGuest).not.toHaveBeenCalled();
  });

  it("rechecks at the guest-person commit after waiting for its lock", async () => {
    let enterMint: (() => void) | undefined;
    let releaseMint: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enterMint = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseMint = resolve;
    });
    guestAuthDependencies.mintGuestPerson = vi.fn(async (validate) => {
      enterMint?.();
      await released;
      validate?.();
      throw new Error("unreachable");
    });

    const opening = continueAsGuest();
    await entered;
    currentSession.mockReturnValue({
      principalId: "prn_member",
      accessToken: "member-tok",
      issuerOrigin: "http://127.0.0.1:18788",
    });
    releaseMint?.();

    await expect(opening).rejects.toThrow(FRESH_GUEST_SIGN_OUT_MESSAGE);
    expect(createGuest).not.toHaveBeenCalled();
  });

  it("requires sign-out before replacing a federated session", async () => {
    loadFederationSession.mockReturnValue({ idToken: "signed-in" });

    await expect(continueAsGuest()).rejects.toThrow(
      FRESH_GUEST_SIGN_OUT_MESSAGE,
    );
    expect(resumeSession).not.toHaveBeenCalled();
    expect(createGuest).not.toHaveBeenCalled();
  });

  it("still resumes the established guest person", async () => {
    await continueAsGuest();
    currentSession.mockReturnValue({
      principalId: "prn_guest",
      accessToken: "guest-tok",
      issuerOrigin: "http://127.0.0.1:18788",
    });

    createGuest.mockClear();
    await expect(resumeGuestSession()).resolves.toBeUndefined();
    expect(createGuest).toHaveBeenCalledWith({ resume: true });
  });

  it("treats resume without a surviving guest person as a fresh guest", async () => {
    clearGuestSessionPerson();
    currentSession.mockReturnValue({
      principalId: "prn_member",
      accessToken: "member-tok",
      issuerOrigin: "http://127.0.0.1:18788",
    });

    await expect(resumeGuestSession()).rejects.toThrow(
      FRESH_GUEST_SIGN_OUT_MESSAGE,
    );
    expect(createGuest).not.toHaveBeenCalled();
  });

  it("still opens an empty vault after completed sign-in", async () => {
    currentSession.mockReturnValue({
      principalId: "prn_member",
      accessToken: "member-tok",
      issuerOrigin: "http://127.0.0.1:18788",
    });
    vaultStatus.mockReturnValueOnce("empty").mockReturnValue("unlocked");

    await expect(openVaultAfterSignIn()).resolves.toBe(true);
    expect(createGuest).toHaveBeenCalledWith({ resume: true });
  });

  it("opens a guest vault and stages a claim notice without minting a resource claim", async () => {
    await continueAsGuest();
    expect(createGuest).toHaveBeenCalledTimes(1);
    expect(connectProvisional).toHaveBeenCalledTimes(1);
    expect(identityJson).not.toHaveBeenCalled();
    const notices = listNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      kind: "guest_claim",
      title: "Claim this guest session",
      body: "You skipped registered sign-in. Sign in with a trusted account to attach it to this principal — the id stays the same.",
    });
    // Each Continue-as-guest mints guest-N; never a bearer.
    const raw = sessionStore().getItem("opensesame.guest.session-person");
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw ?? "{}").name).toMatch(/^guest-[1-9]\d*$/);
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      expect(key).not.toMatch(/token|bearer|refresh/i);
    }
  });

  it("still enters as a guest when Identity minting fails", async () => {
    connectProvisional.mockRejectedValue(new Error("Identity unreachable"));
    await continueAsGuest();
    expect(createGuest).toHaveBeenCalledTimes(1);
    const notices = listNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]?.kind).toBe("guest_claim");
    expect(notices[0]?.body).toMatch(/Identity unreachable/);
  });

  it("uses the generic recovery copy for a non-Error Identity failure", async () => {
    connectProvisional.mockRejectedValue("offline");
    await continueAsGuest();
    expect(listNotices()[0]).toMatchObject({
      kind: "guest_claim",
      body: "Continue as guest succeeded. Claim auth from the notifications bell when you want a registered sign-in.",
    });
  });
});

describe("with no identity service configured (ADR 0090)", () => {
  // The common static deployment: no Identity API at all, and complete that
  // way. A guest is a local vault; a federated sign-in is the broker's
  // assertion held on this device. Neither is "pending" anything.
  beforeEach(() => {
    isRemoteIdentityConfigured.mockReturnValue(false);
  });

  it("enters as a guest with nothing to claim and no notice", async () => {
    await continueAsGuest();
    expect(createGuest).toHaveBeenCalledTimes(1);
    expect(connectProvisional).not.toHaveBeenCalled();
    expect(listNotices()).toHaveLength(0);
  });

  it("adopts a federated identity on first run as a local sign-in", async () => {
    vaultStatus.mockReturnValue("empty");
    await expect(adoptFederatedIdentity("id.token.here")).resolves.toEqual({
      kind: "local",
    });
    expect(createGuest).toHaveBeenCalledTimes(1);
    expect(connectProvisional).not.toHaveBeenCalled();
    expect(identityJson).not.toHaveBeenCalled();
    expect(listNotices()).toHaveLength(0);
    expect(sessionStore().getItem(PENDING_LINK_KEY)).toBeNull();
  });

  it("leaves a locked vault locked and defers nothing", async () => {
    vaultStatus.mockReturnValue("locked");
    currentSession.mockReturnValue(null);
    await expect(adoptFederatedIdentity("id.token.here")).resolves.toEqual({
      kind: "local",
    });
    expect(createGuest).not.toHaveBeenCalled();
    expect(listNotices()).toHaveLength(0);
    expect(sessionStore().getItem(PENDING_LINK_KEY)).toBeNull();
  });
});

describe("linkGuestAccount", () => {
  it("uses the active guest session without persisting its bearer", async () => {
    await continueAsGuest();
    connectProvisional.mockClear();
    currentSession.mockReturnValue({
      principalId: "prn_guest",
      accessToken: "guest-tok",
      issuerOrigin: "http://127.0.0.1:18788",
    });
    await linkGuestAccount("id.token.here");
    expect(connectProvisional).not.toHaveBeenCalled();
    // Guest principal stays; bearer still must not.
    expect(
      sessionStore().getItem("opensesame.guest.session-person"),
    ).toBeTruthy();
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      expect(key).not.toMatch(/token|bearer|refresh/i);
    }
    expect(identityJson).toHaveBeenCalledWith(
      "/v1/principals/link-identities",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ idToken: "id.token.here" }),
      }),
    );
    expect(listNotices()).toHaveLength(0);
  });

  it("stands on the rebound session when the identity already belongs to another principal", async () => {
    identityJson.mockResolvedValue({
      principalId: "prn_existing",
      accessToken: "rebound-tok",
      identity: { assurance: "verified" },
    });
    const outcome = await linkGuestAccount("id.token.here");
    expect(rebindSession).toHaveBeenCalledTimes(1);
    expect(rebindSession.mock.calls[0]?.[0]).toBe("rebound-tok");
    expect(outcome).toEqual({ mintedPrincipal: false });
  });

  it("resumes the HttpOnly cookie when navigation cleared memory", async () => {
    currentSession.mockReturnValue(null);
    await linkGuestAccount("id.token.here");
    expect(connectProvisional).toHaveBeenCalledTimes(1);
    expect(identityJson).toHaveBeenCalledWith(
      "/v1/principals/link-identities",
      expect.objectContaining({
        body: JSON.stringify({ idToken: "id.token.here" }),
      }),
    );
  });
});

const FEDERATION_SESSION_KEY = "opensesame:federation:session";
const PENDING_LINK_KEY = "opensesame:federation:pending-link";

describe("adoptFederatedIdentity", () => {
  it("opens a guest vault on first run, then attaches the identity", async () => {
    vaultStatus.mockReturnValue("empty");
    currentSession.mockReturnValue({
      principalId: "prn_member",
      accessToken: "member-tok",
      issuerOrigin: "http://127.0.0.1:18788",
    });
    await adoptFederatedIdentity("id.token.here");
    expect(createGuest).toHaveBeenCalledTimes(1);
    expect(identityJson).toHaveBeenCalledWith(
      "/v1/principals/link-identities",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ idToken: "id.token.here" }),
      }),
    );
    expect(listNotices()).toHaveLength(0);
    expect(sessionStore().getItem(PENDING_LINK_KEY)).toBeNull();
  });

  it("attaches to the open vault without creating a second one", async () => {
    vaultStatus.mockReturnValue("unlocked");
    await adoptFederatedIdentity("id.token.here");
    expect(createGuest).not.toHaveBeenCalled();
    expect(identityJson).toHaveBeenCalledTimes(1);
  });

  it("defers on a locked vault instead of minting a throwaway principal", async () => {
    vaultStatus.mockReturnValue("locked");
    currentSession.mockReturnValue(null);
    sessionStore().setItem(FEDERATION_SESSION_KEY, '{"idToken":"kept"}');

    await adoptFederatedIdentity("id.token.here");

    expect(createGuest).not.toHaveBeenCalled();
    expect(connectProvisional).not.toHaveBeenCalled();
    expect(identityJson).not.toHaveBeenCalled();
    const notices = listNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      kind: "federated_link",
      title: "Finish attaching your sign-in",
    });
    // The verified assertion must survive so the link can be finished later.
    expect(sessionStore().getItem(FEDERATION_SESSION_KEY)).toBe(
      '{"idToken":"kept"}',
    );
    expect(sessionStore().getItem(PENDING_LINK_KEY)).not.toBeNull();
  });

  it("still lands the user in the app when the first-run link fails", async () => {
    vaultStatus.mockReturnValue("empty");
    identityJson.mockRejectedValue(new Error("Identity unreachable"));

    await expect(
      adoptFederatedIdentity("id.token.here"),
    ).resolves.toMatchObject({ kind: "link_failed" });

    expect(createGuest).toHaveBeenCalledTimes(1);
    const notices = listNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: "guest_claim" });
    expect(notices[0]?.body).toMatch(/Identity unreachable/);
    expect(sessionStore().getItem(PENDING_LINK_KEY)).not.toBeNull();
  });

  it("says plainly when the account belongs to another identity", async () => {
    vaultStatus.mockReturnValue("unlocked");
    identityJson.mockRejectedValue(
      new IdentityError("identity_collision", 409),
    );

    await expect(adoptFederatedIdentity("id.token.here")).rejects.toThrow(
      "That account is already attached to a different OpenSesame identity.",
    );
  });

  it("uses the collision wording in the first-run notice too", async () => {
    vaultStatus.mockReturnValue("empty");
    identityJson.mockRejectedValue(
      new IdentityError("identity_collision", 409),
    );

    await adoptFederatedIdentity("id.token.here");

    expect(listNotices()[0]?.body).toMatch(
      /already attached to a different OpenSesame identity/,
    );
  });

  it("passes non-collision failures through untouched", async () => {
    vaultStatus.mockReturnValue("unlocked");
    identityJson.mockRejectedValue(new IdentityError("nope", 503));
    await expect(adoptFederatedIdentity("id.token.here")).rejects.toThrow(
      "nope",
    );
  });
});

describe("recoverPendingFederatedLink", () => {
  it("does nothing when no link is outstanding", () => {
    loadFederationSession.mockReturnValue({ idToken: "still-here" });
    recoverPendingFederatedLink();
    expect(listNotices()).toHaveLength(0);
  });

  it("raises the prompt again after a reload dropped the notice", async () => {
    vaultStatus.mockReturnValue("locked");
    currentSession.mockReturnValue(null);
    await adoptFederatedIdentity("id.token.here");
    // A reload keeps sessionStorage but empties the in-memory notice list.
    clearNotices();

    loadFederationSession.mockReturnValue({ idToken: "still-here" });
    recoverPendingFederatedLink();

    expect(listNotices()).toHaveLength(1);
    expect(listNotices()[0]).toMatchObject({ kind: "federated_link" });
  });

  it("forgets the pending link once the assertion has expired", async () => {
    vaultStatus.mockReturnValue("locked");
    currentSession.mockReturnValue(null);
    await adoptFederatedIdentity("id.token.here");
    clearNotices();

    loadFederationSession.mockReturnValue(null);
    recoverPendingFederatedLink();

    expect(listNotices()).toHaveLength(0);
    expect(sessionStore().getItem(PENDING_LINK_KEY)).toBeNull();
  });

  it("does not stack a second prompt on top of the one already showing", async () => {
    vaultStatus.mockReturnValue("locked");
    currentSession.mockReturnValue(null);
    await adoptFederatedIdentity("id.token.here");

    loadFederationSession.mockReturnValue({ idToken: "still-here" });
    recoverPendingFederatedLink();

    expect(listNotices()).toHaveLength(1);
  });
});
