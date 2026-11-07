// The package's entry is TypeScript source (every workspace package's is), so
// a consumer compiles these files itself and needs oidc-provider's ambient
// declaration, which the library does not ship. Referencing it here brings it
// into any program that imports the package.
/// <reference path="./oidc-provider-shim.d.ts" />

export { createMemoryAdapterConstructor } from "./adapter/memory-adapter.js";
export {
  type OidcAdapter,
  type OidcAdapterConstructor,
  type OidcAdapterPayload,
  type PostgresOidcStore,
  createPostgresAdapterConstructor,
} from "./adapter/types.js";
export {
  type AccountLookup,
  type FindAccountOptions,
  type LookupAccount,
  type MapClaims,
  createFindAccount,
} from "./claims/find-account.js";
export {
  type AccountPrincipal,
  type ClaimMapping,
  type ProjectAccountClaimsInput,
  RESERVED_PROTOCOL_CLAIMS,
  ReservedClaimError,
  previewAccountClaims,
  projectAccountClaims,
} from "./claims/project-account-claims.js";
export {
  ClientAdmissionError,
  type ClientAdmissionPolicy,
  createClientAdmissionPolicy,
  defaultAdmissionFromEnv,
} from "./clients/admission.js";
export {
  type ResolveOriginClientOptions,
  findOriginClient,
  resolveOriginClient,
  toOidcClientMetadata,
} from "./clients/origin-resolve.js";
export {
  type ClientRecordStore,
  type InsertOptions,
  MemoryClientRecordStore,
  SectorKeyClaimedError,
} from "./clients/store.js";
export { createLoadExistingGrant } from "./consent/load-existing-grant.js";
export {
  type TokenCorsDecision,
  evaluateTokenCors,
} from "./cors/token-cors.js";
export {
  type CreateOpenSesameProviderOptions,
  type OpenSesameProviderBundle,
  canonicalResource,
  createOpenSesameProvider,
  isPkceRequired,
  isResourceAllowed,
} from "./create-provider.js";
export { readOAuthProviderEnv } from "./env.js";
export {
  CLIENT_CREDENTIALS_FEATURE,
  SERVICE_ACCESS_TOKEN_MAX_SECONDS,
  assertConfidentialClientCredentials,
  isPublicClient,
} from "./grants/client-credentials.js";
export { type JwtReplayCache, ReplayCache } from "./grants/replay-cache.js";
export { EnvSigningKeyProvider } from "./keys/dev-signing-key-provider.js";
export {
  SafeMetadataFetcher,
  UnsafeMetadataUrlError,
  assertSafeMetadataUrl,
} from "./metadata/safe-fetcher.js";
export {
  type MtlsPeer,
  type MtlsTransport,
  buildMtlsFeature,
  certificateSubjectMatches,
  combineExtraClientMetadata,
  mtlsClientAuthMethods,
  mtlsClientFence,
  mtlsDiscovery,
} from "./mtls/feature.js";
export {
  type CanonicalizeOriginOptions,
  OriginError,
  type OriginErrorCode,
  canonicalizeOrigin,
  defaultCallbackUri,
  originClientId,
  parseOriginClientId,
} from "./origin/canonical.js";
export {
  canonicalSectorIdentifier,
  pairwiseSectorKey,
  pairwiseSubjectSector,
  sectorIdentifierSpellings,
} from "./pairwise/sector.js";
export {
  MemoryPairwiseSubjectStore,
  type PairwiseClientLookup,
  createPairwiseIdentifierCallback,
} from "./pairwise/store.js";
export type {
  ClientAdmissionMode,
  ClientState,
  OAuthClientRecord,
  OAuthProviderEnv,
  OwnershipStatus,
  PairwiseSubject,
  PairwiseSubjectStore,
  SectorKeyRelease,
} from "./types.js";
export { ORIGIN_PROFILE_FORBIDDEN_SCOPES } from "./types.js";
