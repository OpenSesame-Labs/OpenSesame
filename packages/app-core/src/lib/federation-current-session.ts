import { isBrokeredIssuer } from "./federation-broker.js";
import { configuredIdentitySessionTrusted } from "./federation-configured-token.js";
import {
  type UpstreamIdentity,
  readNativeFederationSession,
} from "./federation-native-session.js";
import { isOperatorIdpIssuer } from "./federation-operator.js";
import { clearFederationSession } from "./federation-retirement.js";
import { readFederationSessionJson } from "./federation-session-store.js";
import { readStoredSessionSync } from "./federation-stored-session.js";
import { upstreamByIssuer } from "./federation-upstreams.js";

export function issuerIsTrusted(issuer: string): boolean {
  return Boolean(
    upstreamByIssuer(issuer) ||
      isBrokeredIssuer(issuer) ||
      isOperatorIdpIssuer(issuer),
  );
}

export function loadCurrentFederationSession(): UpstreamIdentity | null {
  const native = readNativeFederationSession();
  if (native) return native;
  const raw = readFederationSessionJson();
  if (!raw) return null;
  const identity = readStoredSessionSync(raw, issuerIsTrusted);
  if (!identity || !configuredIdentitySessionTrusted(identity)) {
    clearFederationSession();
    return null;
  }
  return identity;
}

/** Shared by the facade and sign-out so both use the same session view. */
export const federationCurrentSessionSeam = {
  load: loadCurrentFederationSession,
};
