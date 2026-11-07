export {
  type AuthenticationService,
  AuthenticationServiceError,
  type AuthenticationSigninMode,
  DEFAULT_AUTHENTICATION_CONFIGURATIONS,
  authenticationApplicationSecretMatches,
  createAuthenticationService,
  hashAuthenticationToken,
  mintAuthenticationApplicationSecret,
  visibleAuthenticationAlias,
} from "./authentication-service.js";
export {
  type BetterAuthUser,
  type CreateUpstreamAuthOptions,
  type MagicLinkDelivery,
  type MagicLinkMetadata,
  type MagicLinkRequestAccepted,
  type MagicLinkVerification,
  type SocialProviderConfig,
  type UpstreamAuth,
  type UpstreamAuthBundle,
  type UpstreamAuthDatabase,
  type UpstreamMagicLinkOptions,
  createUpstreamAuth,
} from "./better-auth.js";
export { type EmailLinkPolicy, noEmailAutoLinkPolicy } from "./email-link.js";
export {
  MemoryPrincipalMappingStore,
  type PrincipalMapping,
  type PrincipalMappingStore,
} from "./mapping.js";
export {
  type UpstreamOidcProvider,
  UpstreamOidcProviderRegistry,
  mockUpstreamProvider,
} from "./oidc-registry.js";
export {
  type PasskeyAssertion,
  type PasskeyCredential,
  type PasskeyCredentialStore,
  type PasskeySeam,
  type PasskeyVerifyFn,
  type PasskeyVerifyResult,
  createMemoryPasskeyCredentialStore,
  createPasskeySeam,
} from "./passkey.js";
export {
  type CreateProvisionalOptions,
  type ProvisionalSession,
  type UpgradeToUpstreamInput,
  createProvisionalPrincipal,
  upgradeProvisionalToUpstream,
} from "./provisional.js";
export { simpleWebAuthnSeams } from "./simplewebauthn.js";
export {
  type ChallengeMeta,
  type ChallengePurpose,
  type PasskeyChallengeStore,
  type VerifiedRegistration,
  type WebAuthnRpConfig,
  createMemoryChallengeStore,
  createSimpleWebAuthnVerifyFn,
  generatePasskeyAuthenticationOptions,
  generatePasskeyRegistrationOptions,
  issueAuthenticationChallenge,
  issueRegistrationChallenge,
  issueTransactionChallenge,
  verifyPasskeyAuthentication,
  verifyPasskeyRegistration,
  verifyRegistrationAttestation,
} from "./webauthn.js";
