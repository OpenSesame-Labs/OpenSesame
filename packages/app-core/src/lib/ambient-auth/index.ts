export {
  assertSafeReturnTo,
  isAuthCallbackSearch,
  parseAuthCallback,
} from "../federation-callback.js";
export {
  readStoredSessionSync,
  restoreAuthenticatedSession,
} from "../federation-restoration.js";
export {
  admitAmbientSession,
  ambientAdmissionSeams,
  vaultStateFromStore,
} from "./admission.js";
export { completeAmbientIfPresent } from "./complete.js";
export {
  type ControllerState,
  type Eligibility,
  type EligibilityInput,
  ambientControllerSeams,
  evaluateEligibility,
  resetAmbientController,
  startAutomaticAttempt,
} from "./controller.js";
export {
  ENTRA_SCOPES,
  acquireEntraSilent,
  entraJwksUri,
  entraRedirectBridgePath,
  entraSeams,
} from "./entra.js";
export {
  clearAutoAuthSuppression,
  currentAuthGeneration,
  fenceLocalSignOut,
  isAutoAuthSuppressed,
  matchesAuthGeneration,
  readAuthFence,
} from "./generation.js";
export {
  AMBIENT_SCOPES,
  beginAmbientOidc,
  exchangeAmbientCode,
} from "./oidc.js";
export {
  type AmbientAuthPolicy,
  type AmbientPolicyDecision,
  USER_AMBIENT_PREFERENCE_KEY,
  clearUserAmbientPreference,
  defaultAmbientAuthPolicy,
  readUserAmbientPreference,
  resolveAmbientAuthPolicy,
  writeUserAmbientPreference,
} from "./policy.js";
export {
  type ProviderConnection,
  capabilitiesForProtocol,
  domainOnlyBrokerHint,
  normalizePrompt,
  parseProviderConnectionKey,
  protocolForIssuer,
  providerConnectionKey,
  supportsCapability,
} from "./provider.js";
export { ambientReturnSeams, applyAmbientReturn } from "./return-path.js";
export {
  cancelAllTransactions,
  inspectLegacyPending,
  legacyPendingUsableForAmbient,
} from "./transactions.js";
export type {
  AmbientAuthMode,
  AmbientReasonCode,
  AmbientTransport,
  AuthenticationIntent,
  PassiveOutcome,
} from "./types.js";
export { isAmbientIntent } from "./types.js";
