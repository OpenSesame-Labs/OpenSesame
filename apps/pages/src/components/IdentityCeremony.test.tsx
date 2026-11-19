/** @vitest-environment jsdom */

import type { ConnectorStatus } from "@opensesame/app-core/lib/connectors.js";
import { FRESH_GUEST_SIGN_OUT_MESSAGE } from "@opensesame/app-core/lib/guest-auth.js";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IdentityCeremony,
  expiryPhrase,
  identityCeremonyDependencies,
} from "./IdentityCeremony.js";
import { expectInTray } from "./tray.test-support.js";

const original = { ...identityCeremonyDependencies };
const NOW = Date.parse("2026-01-01T00:00:00Z");

function connector(over: Partial<ConnectorStatus> = {}): ConnectorStatus {
  return {
    id: "identity",
    name: "Identity",
    tone: "live",
    detail: "127.0.0.1:18788",
    failure: null,
    lastCheckedAt: NOW,
    checking: false,
    rttMs: 9,
    ...over,
  };
}

beforeEach(() => {
  Object.assign(identityCeremonyDependencies, {
    ...original,
    useIdentitySession: () => null,
    beginSignIn: vi.fn(),
    defaultUpstream: () => ({
      id: "mock",
      displayName: "Local mock IdP",
      issuer: "http://127.0.0.1:9090",
      accountKind: "a seeded test account",
    }),
    claimGuestAuth: vi.fn().mockResolvedValue(undefined),
    connectFreshProvisional: vi.fn().mockResolvedValue(undefined),
    clearSession: vi.fn(),
    signOut: vi.fn(),
    ensureIdentitySession: vi.fn().mockResolvedValue(undefined),
    identityBase: () => "http://127.0.0.1:18788",
  });
});

afterEach(() => {
  cleanup();
  Object.assign(identityCeremonyDependencies, original);
});

describe("expiryPhrase", () => {
  it("says so plainly when no horizon was stated", () => {
    // A pasted CLI token carries no expiry — only the API knows it. Inventing
    // a countdown would be believed exactly as much as a real one.
    expect(expiryPhrase(undefined, NOW)).toBe("not stated");
    expect(expiryPhrase("not-a-date", NOW)).toBe("not stated");
  });

  it("does not pretend an elapsed credential is still good", () => {
    expect(expiryPhrase(new Date(NOW - 1_000).toISOString(), NOW)).toBe(
      "expired",
    );
  });

  it("scales the unit to the distance", () => {
    const at = (ms: number) => new Date(NOW + ms).toISOString();
    expect(expiryPhrase(at(30_000), NOW)).toBe("in 30 s");
    expect(expiryPhrase(at(20 * 60_000), NOW)).toBe("in 20 min");
    expect(expiryPhrase(at(11 * 3_600_000), NOW)).toBe("in 11 h");
    expect(expiryPhrase(at(4 * 86_400_000), NOW)).toBe("in 4 d");
  });
});

describe("IdentityCeremony", () => {
  it("names the principal and who issued it when signed in", () => {
    Object.assign(identityCeremonyDependencies, {
      useIdentitySession: () => ({
        principalId: "prn_abc123",
        accessToken: "t",
        issuerOrigin: "http://127.0.0.1:18788",
        expiresAt: new Date(Date.now() + 11 * 3_600_000).toISOString(),
      }),
    });
    render(<IdentityCeremony connector={connector()} onClose={() => {}} />);
    // A signed-in glyph used to open onto a sheet whose only content was two
    // buttons offering to sign in again — it never said who you were.
    expect(screen.getByText("prn_abc123")).toBeTruthy();
    expect(screen.getByText("127.0.0.1:18788")).toBeTruthy();
    expect(screen.getByText("Session active")).toBeTruthy();
  });

  it("keeps this device a peer of sign-in, not a click deeper", () => {
    render(<IdentityCeremony connector={connector()} onClose={() => {}} />);
    // Connecting this device is a daily path. Demoting it into a disclosure
    // would add an interaction to the flow most people take. It is not the
    // guest tomb, and it does not reuse that sign-in phrase.
    expect(
      screen.getByRole("button", { name: "Use this device" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Continue as guest" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", {
        name: "Sign in with a seeded test account",
      }),
    ).toBeTruthy();
  });

  it("does not reuse a surviving remote session as this device", async () => {
    const signOut = vi.fn();
    const onClose = vi.fn();
    Object.assign(identityCeremonyDependencies, {
      signOut,
      connectFreshProvisional: vi
        .fn()
        .mockRejectedValue(new Error(FRESH_GUEST_SIGN_OUT_MESSAGE)),
    });
    render(<IdentityCeremony connector={connector()} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Use this device" }));

    await expectInTray(FRESH_GUEST_SIGN_OUT_MESSAGE);
    expect(screen.getByText("Browser session detected")).toBeTruthy();
    expect(
      screen.getByText("Browser session detected").closest(".found--attn"),
    ).toBeTruthy();
    expect(screen.getByText("Sign out before continuing")).toBeTruthy();
    expect(screen.queryByText("Not signed in")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Use this device" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /Sign in with/ })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Use a token from the CLI/ }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Sign out to continue" }),
    );
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clears the credential before refreshing, or the refresh is a no-op", () => {
    const clearSession = vi.fn();
    Object.assign(identityCeremonyDependencies, {
      clearSession,
      useIdentitySession: () => ({
        principalId: "prn_abc123",
        accessToken: "t",
        issuerOrigin: "http://127.0.0.1:18788",
      }),
    });
    render(<IdentityCeremony connector={connector()} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh session" }));
    // ensureIdentitySession reuses a live session, so refreshing without
    // clearing would report success having changed nothing.
    expect(clearSession).toHaveBeenCalledTimes(1);
  });

  it("reports a failed refresh instead of claiming success", async () => {
    Object.assign(identityCeremonyDependencies, {
      ensureIdentitySession: vi
        .fn()
        .mockRejectedValue(new Error("Identity unavailable")),
      useIdentitySession: () => ({
        principalId: "prn_abc123",
        accessToken: "t",
        issuerOrigin: "http://127.0.0.1:18788",
      }),
    });
    render(<IdentityCeremony connector={connector()} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh session" }));
    await expectInTray("Identity unavailable");
    expect(screen.queryByText("Session refreshed.")).toBeNull();
  });

  it("offers to swap accounts only when there is one to swap", () => {
    render(<IdentityCeremony connector={connector()} onClose={() => {}} />);
    expect(
      screen.queryByRole("button", { name: /Sign in as someone else/ }),
    ).toBeNull();
  });

  it("adopts a CLI token from inside the sheet", () => {
    render(<IdentityCeremony connector={connector()} onClose={() => {}} />);
    fireEvent.click(
      screen.getByRole("button", { name: /Use a token from the CLI/ }),
    );
    expect(screen.getByLabelText("Access token")).toBeTruthy();
  });

  it("never renders a link out of the sheet", () => {
    const { container } = render(
      <IdentityCeremony connector={connector()} onClose={() => {}} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Use a token from the CLI/ }),
    );
    expect(container.querySelector("a")).toBeNull();
  });
});
