export {
  type AuthenticationClientConfig,
  type PasswordlessSignin,
  createAuthenticationClient,
} from "./authentication-service.js";
export { createOpenSesame } from "./client.js";
export { ClaimRequestError } from "./errors.js";
export { decodeJwtEnvelope } from "./jwt-envelope.js";
export {
  type VerifiedIdTokenClaims,
  type VerifyBrowserIdTokenInput,
  type VerifyRestoredIdTokenInput,
  fetchOidcJson,
  verifyBrowserIdToken,
  verifyBrowserIdTokenClaims,
  verifyRestoredBrowserIdToken,
} from "./oidc-validation.js";
export {
  BrowserOriginError,
  OriginError,
  assertSafeReturnTo,
  canonicalizeBrowserOrigin,
  defaultOriginCallback,
  originProfileClientId,
} from "./origin.js";
export {
  base64UrlEncode,
  createPkcePair,
  randomString,
  sha256Base64Url,
} from "./pkce.js";
export type {
  ClaimDecision,
  ClaimPresentation,
  OidcDiscoveryDocument,
  OpenSesameBrowserClient,
  OpenSesameBrowserConfig,
  Session,
  StorageLike,
  TokenResponse,
} from "./types.js";
export {
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  assertionPayload,
  authenticationResponseJson,
  b64urlToBytes,
  bytesToB64url,
  creationOptionsFromJson,
  isPublicKeyCredential,
  parsePublicKeyCredentialCreationOptionsJson,
  parsePublicKeyCredentialRequestOptionsJson,
  registrationResponseJson,
  requestOptionsFromJson,
} from "./webauthn.js";
