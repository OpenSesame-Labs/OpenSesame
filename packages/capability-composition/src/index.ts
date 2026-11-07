export {
  DIGEST_PREFIX,
  DIGEST_RE,
  type PlanDigestBody,
  canonicalize,
  digestOf,
  exposureDigest,
  planDigest,
  receiptDigest,
  sha256Hex,
  sortConflicts,
} from "./canonical.js";
export {
  type CatalogIndex,
  MAX_CATALOG_CAPABILITIES,
  MAX_DEPENDENCY_DEPTH,
  MAX_SUMMARY_LENGTH,
  MAX_TITLE_LENGTH,
  buildCatalog,
  indexCatalog,
  validateCatalog,
} from "./catalog.js";
export { MAX_DESCRIPTOR_LIST } from "./catalog-fields.js";
export {
  type ConsentCandidates,
  buildConsentReceipt,
  computeConsentDelta,
  consentCandidatesOf,
} from "./consent.js";
export { diagnoseRuntimeDocuments } from "./diagnose.js";
export type {
  Diagnostic,
  DiagnosticCode,
  ParseResult,
  ValidationResult,
} from "./diagnostics.js";
export { DIAGNOSTIC_CODES, MAX_DIAGNOSTICS } from "./diagnostics.js";
export {
  parseInstallationSelection,
  parseInstancePolicy,
  parseVaultSelection,
  parseWorkspaceRestriction,
} from "./documents.js";
export {
  parseConsentReceipt,
  parseDistributionContract,
} from "./documents-runtime.js";
export {
  FIXTURE_CATALOG,
  FIXTURE_DISTRIBUTION,
  FIXTURE_FACTS,
  FIXTURE_INSTALLATION,
  FIXTURE_INSTALLATION_ID,
  FIXTURE_POLICIES,
  fixtureResolveInput,
  fixtureSelection,
} from "./fixtures.js";
export {
  MAX_ID_LENGTH,
  MAX_MODULE_ID_LENGTH,
  MAX_OPAQUE_ID_LENGTH,
  MAX_REVISION_LENGTH,
  compareIds,
  isCapabilityId,
  isModuleId,
  isOpaqueId,
  isUnitName,
  isWorkerModule,
  moduleCapability,
  sortIds,
} from "./ids.js";
export {
  KEY_ACCESS_CLASSES,
  keyAccessClasses,
  keyAccessDigestBody,
  keyAccessProblem,
} from "./key-access.js";
export { isServiceOrigin } from "./origins.js";
export { MAX_LIST_IDS } from "./parse-primitives.js";
export { BLOCKING_REASONS, REASON_CODES, sortReasons } from "./reasons.js";
export {
  capabilityState,
  explainCapability,
  resolveComposition,
} from "./resolve.js";
export {
  NO_SELECTION_REVISION,
  PERSONAL_LOCAL_INSTANCE,
  PERSONAL_LOCAL_NETWORK,
  PERSONAL_LOCAL_REVISION,
  isVaultForeign,
} from "./resolve-axes.js";
export type { ResolveInput } from "./resolve-input.js";
export { reviewCompositionChange } from "./review.js";
export * from "./types.js";
