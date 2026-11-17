/** Capture the initiating document and sign-out fence before any async work. */
import { host } from "../host.js";
import { page, pageOrigin } from "../ports.js";
import { FederationError } from "./federation-error.js";
import { federationSessionGeneration } from "./federation-native-session.js";
import { originClientId, redirectUri } from "./federation-origin.js";
import { TRUSTED_UPSTREAMS } from "./federation-upstreams.js";
import {
  assertGuestReturnEpoch,
  captureGuestReturnEpoch,
} from "./guest-return-epoch.js";
import { isLocalOnlyGuest } from "./guest-session-context.js";
import { remoteIdentityApi } from "./identity.js";
import { signInMethods } from "./settings.js";

function callbackTrust(): string {
  return JSON.stringify({
    upstreams: TRUSTED_UPSTREAMS,
    broker: remoteIdentityApi(),
    signIn: signInMethods(),
  });
}

export function captureFederationAction() {
  const originalHost = host();
  const { search, origin, href } = page().location;
  const generation = federationSessionGeneration();
  const authEpoch = captureGuestReturnEpoch();
  const trust = callbackTrust();
  const originalFetch = fetch;
  let expectedHref = href;
  const assertConfiguration = () => {
    if (isLocalOnlyGuest())
      throw new FederationError(
        "sign_in_cancelled",
        "This vault is local only. Sign out and start a new guest session to connect services.",
      );
    if (authEpoch !== null) {
      try {
        assertGuestReturnEpoch(authEpoch);
      } catch {
        throw new FederationError(
          "sign_in_cancelled",
          "That sign-in was ended by a sign-out. Start again.",
        );
      }
    }
    if (
      host() !== originalHost ||
      pageOrigin() !== origin ||
      page().location.href !== expectedHref ||
      fetch !== originalFetch ||
      callbackTrust() !== trust
    )
      throw new FederationError(
        "invalid_request",
        "Identity configuration changed or callback was replaced during sign-in; start again",
      );
  };
  const assertCurrent = () => {
    if (federationSessionGeneration() !== generation)
      throw new FederationError(
        "sign_in_cancelled",
        "That sign-in was ended by a sign-out. Start again.",
      );
    assertConfiguration();
  };
  return Object.freeze({
    search,
    origin,
    generation,
    authEpoch,
    clientId: originClientId(origin),
    redirectUri: redirectUri(),
    assertCurrent,
    assertConfiguration,
    scrub() {
      assertCurrent();
      const url = new URL(expectedHref);
      for (const key of [
        "code",
        "state",
        "error",
        "error_description",
        "scope",
      ])
        url.searchParams.delete(key);
      expectedHref = url.toString();
      page().replaceUrl(expectedHref);
      assertCurrent();
    },
  });
}

export type CallbackCapture = ReturnType<typeof captureFederationAction>;
