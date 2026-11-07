/**
 * BUILD swarm: opt-in duress feature registration, offline readiness, format refusal.
 */

export {
  type AssetProbe,
  type AssuranceLevel,
  DuressOfflineAssetCache,
  type OfflineAssetEntry,
  type OfflineReadinessReport,
  evaluateOfflineAssetReadiness,
} from "./assets.js";
export {
  type DuressFormatHeader,
  type FormatRefusal,
  assertReadableDuressHeader,
  explainFormatRefusal,
  refuseUnsupportedDuressFormat,
} from "./format.js";

export {
  type DuressAssetReadiness,
  type DuressFeatureRegistration,
  type LoadDuressRuntimeResult,
  compareDuressModes,
  compareFeatureModes,
  enrollmentAssetReadiness,
  loadDuressRuntime,
  registerDuressFeature,
  resolveDuressMode,
} from "./mode.js";
export {
  DURESS_CAPABILITIES,
  type DuressCapability,
  type DuressCapabilityId,
  capabilitiesForMode,
  capabilityIdsForMode,
  unsupportedCapabilitiesForMode,
} from "./registry.js";
export {
  DURESS_STATIC_CONSTRAINTS,
  type StaticConstraintProbe,
  type StaticConstraintReport,
  checkStaticHostingConstraints,
} from "./static.js";
export {
  type SwAssetManifest,
  type SwMismatchReport,
  clampAssuranceForSw,
  evaluateServiceWorkerMismatch,
} from "./sw-mismatch.js";
export {
  DURESS_READER_VERSION,
  type DuressFeatureMode,
  isDuressFeatureEnabled,
} from "./types.js";
