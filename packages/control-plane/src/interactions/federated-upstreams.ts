import type { ControlPlaneConfig } from "../config.js";
import { isLoopbackIssuer } from "./issuer-loopback.js";

/** An allowlisted upstream, as offered on the hosted login page. */
export type FederatedUpstream = {
  /** Stable id used to match the SDK's `kc_idp_hint` / `login_hint_provider`. */
  id: string;
  issuer: string;
  /** What the button says: "Sign in with {label}". */
  label: string;
};

const MOCK_UPSTREAM_LABEL = "a local test account";

function issuerHost(issuer: string): string {
  try {
    return new URL(issuer).host;
  } catch {
    return issuer;
  }
}

/**
 * Label and id for an allowlisted issuer. Mirrors the Pages `TRUSTED_UPSTREAMS`
 * table (`packages/app-core/src/lib/federation.ts`) so both surfaces name the same
 * broker the same way — shoo.dev fronts Google sign-in but is a third-party
 * broker, and the label says so instead of impersonating first-party Google
 * (real `accounts.google.com` is registry id `google`, ADR 0055).
 */
function describeUpstream(issuer: string): FederatedUpstream {
  if (issuer === "https://shoo.dev") {
    return { id: "shoo", issuer, label: "Google (via shoo.dev)" };
  }
  if (isLoopbackIssuer(issuer)) {
    return { id: "mock", issuer, label: MOCK_UPSTREAM_LABEL };
  }
  return { id: issuerHost(issuer), issuer, label: issuerHost(issuer) };
}

/**
 * The allowlist as upstream descriptions. The hosted login page renders the
 * richer registry view (`staticProviders`, ADR 0055) instead; this stays as
 * the plain allowlist projection the config surface and its tests describe.
 */
export function federatedUpstreams(
  config: ControlPlaneConfig,
): FederatedUpstream[] {
  return config.trustedUpstreamIssuers.map(describeUpstream);
}

/**
 * Resolve a provider hint (`kc_idp_hint` / `login_hint_provider`) to an
 * allowlisted issuer. Matches id, issuer, host, or label, case-insensitively.
 * An unknown hint resolves to undefined and is ignored — never echoed.
 *
 * The login page uses `matchProviderHint` (`./handlers.ts`), which applies the
 * frozen id > issuer > host > label precedence over registry descriptors.
 */
export function matchUpstreamHint(
  upstreams: FederatedUpstream[],
  hint: string | undefined,
): FederatedUpstream | undefined {
  if (!hint) return undefined;
  const needle = hint.trim().toLowerCase();
  if (!needle) return undefined;
  return upstreams.find(
    (u) =>
      u.id.toLowerCase() === needle ||
      u.issuer.toLowerCase() === needle ||
      issuerHost(u.issuer).toLowerCase() === needle ||
      u.label.toLowerCase() === needle ||
      // "Google (via shoo.dev)" still answers to the bare account kind, so a
      // client that has always hinted `google` keeps preselecting the broker.
      u.label.toLowerCase().startsWith(`${needle} (`),
  );
}

export function isTrustedUpstream(
  config: ControlPlaneConfig,
  issuer: string,
): boolean {
  return config.trustedUpstreamIssuers.includes(issuer);
}
