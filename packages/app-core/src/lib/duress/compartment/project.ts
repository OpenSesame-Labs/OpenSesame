/**
 * Presentation projection entrypoints (COMPARTMENT-UX).
 * Cryptographic admission via session keys — not cosmetic filters (INV-05).
 */

export type { PresentationClass } from "../access/context.js";
export {
  type LimitedCarrySelection,
  type ProjectionQuery,
  type VaultItemView,
  assertNoCrossCompartmentLeak,
  canRestoreLimitedCarry,
  decoyConnectorAllowed,
  projectConnectors,
  projectCounts,
  projectLimitedCarry,
  projectVisibleItems,
  resolveDecoyOrLocked,
  selectLimitedCarry,
} from "./compat.js";
export {
  type ConnectorDecision,
  type SafeConnectionApproval,
  approveSafeLowAuthorityConnection,
  decideConnectorAttach,
} from "./connectors.js";
export {
  type LimitedCarryBundle,
  type LimitedCarryPlan,
  buildLimitedCarryPlan,
  materializeLimitedCarry,
  previewLimitedCarryExposure,
  restoreLimitedCarryOffline,
} from "./limited-carry.js";
export {
  type CompartmentItem,
  type CompartmentKind,
  type CompartmentPlaintext,
  type PublishedCompartment,
  buildTopology,
  createKeyedCompartment,
  openPublishedCompartment,
  requireIndependentPresentation,
  updateDecoyContents,
} from "./registry.js";
export {
  type ScopeQuery,
  type ScopedView,
  accessibleProjection,
  admittedSwitcherTargets,
  assertNoProtectedLeak,
  attachmentPreviewAllowed,
  itemPreview,
  passkeyActionAllowed,
  projectConnectorRefs,
  projectScopedView,
  totpActionAllowed,
} from "./scope.js";
export {
  type SealedCompartmentBlob,
  importCompartmentKey,
  openCompartmentJson,
  sealCompartmentJson,
} from "./seal.js";
export {
  type AdmittedKey,
  type OpenOutcome,
  type PresentationSession,
  mintPresentationSession,
  openPresentation,
  tryOpenWithForeignKey,
} from "./session.js";
