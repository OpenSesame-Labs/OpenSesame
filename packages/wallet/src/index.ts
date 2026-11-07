/**
 * Wallet passes for cross-device interactions (ADR 0086).
 *
 * The package is deliberately two things and not three: a vendor-neutral
 * provider boundary that callers program against, and one real adapter that
 * implements it. There is no "wallet service" here, no storage, and no
 * ambient configuration — a gateway route or a CLI verb parses the environment
 * once, gets a provider, and asks it for capabilities before promising a human
 * anything.
 *
 * The security-critical export is `assertPassPayloadSafe`. It is not optional
 * garnish for tests: both the issue path and the update path run it on every
 * payload before anything is signed or sent, because a wallet pass is the one
 * artifact this system produces that can never be recalled.
 */

export {
  GOOGLE_WALLET_ENV,
  type GoogleWalletConfig,
  type GoogleWalletDisabled,
  type GoogleWalletEnabled,
  WalletConfigError,
  type WalletEnvSource,
  parseGoogleWalletConfig,
} from "./config.js";
export {
  type GoogleBarcode,
  type GoogleGenericClass,
  type GoogleGenericObject,
  type GoogleLocalizedString,
  type GoogleObjectState,
  type GoogleTextModule,
  type GoogleTimeInterval,
  type GoogleUriEntry,
  type GoogleWalletProvider,
  type GoogleWalletProviderOptions,
  buildGenericClass,
  buildGenericObject,
  createGoogleWalletProvider,
} from "./google.js";
export {
  type GoogleClient,
  type GoogleClientOptions,
  createGoogleClient,
} from "./google-client.js";
export {
  NullLauncherProvider,
  type WalletLauncherArtifact,
  type WalletLauncherCapabilities,
  type WalletLauncherProvider,
  createGoogleLauncherProvider,
  createWalletLauncherProvider,
  newRotatingBarcodeSeed,
} from "./launcher.js";
export {
  WalletPayloadRejected,
  type WalletPayloadRule,
  assertPassPayloadSafe,
} from "./payload.js";
export {
  NullWalletProvider,
  type WalletCapabilities,
  type WalletDisplayRow,
  WalletInputError,
  WalletNotConfiguredError,
  type WalletPassArtifact,
  type WalletPassIssueInput,
  type WalletPassProvider,
  type WalletPassRevokeInput,
  type WalletPassState,
  type WalletPassUpdateInput,
  WalletRequestError,
} from "./provider.js";
export {
  type GoogleLauncherProvisioningObject,
  type GoogleLauncherPublicObject,
  type GoogleRotatingBarcode,
  type GoogleTotpDetails,
  type GoogleTotpParameter,
  type RotatingBarcodeSeed,
  WalletLauncherError,
  type WalletLauncherInput,
  assertLauncherPublicSafe,
  buildLauncherProvisioningObject,
  buildLauncherPublicObject,
  launcherObjectId,
  launcherUrl,
} from "./registration.js";
export {
  InMemoryWalletRegistrationStore,
  type WalletRegistration,
  WalletRegistrationConflictError,
  type WalletRegistrationInput,
  type WalletRegistrationState,
  type WalletRegistrationStore,
} from "./registry.js";

import {
  type GoogleWalletConfig,
  type WalletEnvSource,
  parseGoogleWalletConfig,
} from "./config.js";
import { createGoogleWalletProvider } from "./google.js";
import { NullWalletProvider, type WalletPassProvider } from "./provider.js";

/**
 * The provider a deployment should use, given its environment.
 *
 * Configuration errors propagate: a deployment that half-configured its wallet
 * must find out at startup, not when a human taps a dead save button. A
 * deployment that configured nothing gets `NullWalletProvider`, which is a
 * working system that says so.
 */
export function createWalletProvider(env: WalletEnvSource): WalletPassProvider {
  const config: GoogleWalletConfig = parseGoogleWalletConfig(env);
  if (!config.enabled) return new NullWalletProvider();
  return createGoogleWalletProvider({ config });
}
