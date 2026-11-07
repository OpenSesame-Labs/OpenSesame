/**
 * Ceremony logic shared by every surface that runs one: Pages, which hosts
 * every ceremony a link opens (ADR 0140), the Identity API's link builder,
 * and the CLIs.
 *
 * Pure logic only — no React, no storage of its own, no ambient `fetch`. Each
 * surface passes in the pieces that differ: Pages resolves its Identity API
 * at runtime from the deployment's settings and decides which storage a
 * bearer may touch. Following the `@opensesame/qr` convention, the logic is
 * shared here and each app keeps its own JSX.
 *
 * Cross-device interaction links (ADR 0086) are built, parsed, driven and
 * rendered here and nowhere else. Four apps used to hold four private copies
 * of that knowledge, which meant four link formats, four expiry stories, and
 * four independent chances to put a bearer in a URL.
 */

export {
  APPROVAL_LABELS,
  APPROVAL_WORDS,
  type ApprovalAssurance,
  type AuthorizationDetailView,
  CHANNEL_NAMES,
  arrivedViaSentence,
  assuranceSummary,
  channelKindOf,
  channelLabel,
  channelName,
  describeDetail,
  needsCeremony,
  requirementSentence,
  requirementSentences,
  riskSentence,
} from "./approval-copy.js";
export {
  type ApprovalArrival,
  type ApprovalArrivalRead,
  approvalRefAt,
  isApprovalRef,
  readApprovalArrival,
} from "./approval-link.js";
export {
  type ApprovalEnding,
  type ApprovalPhase,
  type ApprovalReview,
  type ApprovalReviewDeps,
  type ApprovalStep,
  type DecisionInput,
  createApprovalReview,
} from "./approval-review.js";
export {
  ApprovalError,
  type ApprovalRefusal,
  type ApprovalRefusalKind,
  COMPARISON_MISMATCH,
  approvalRefusal,
  approvalWords,
} from "./approval-words.js";
export {
  type AuthenticatorInvocation,
  AuthenticatorInvocationError,
  parseAuthenticatorInvocation,
} from "./authenticator-invocation.js";
export {
  type ApprovalActivationChallenge,
  type ApprovalRequirement,
  type ApprovalVerb,
  type AuthorizationRequestClient,
  type AuthorizationRequestClientOptions,
  type AuthorizationRequestView,
  type SettleInput,
  createAuthorizationRequestClient,
  readAuthorizationRequest,
} from "./authorization-request-client.js";
export {
  AUTHENTICATOR_INVOCATION_KINDS,
  type AuthenticatorInvocationKind,
  CEREMONY_ROUTES,
  type CeremonyRoute,
  type CeremonyRouteId,
  type InvokeKind,
  LEGACY_LINKS,
  type LegacyLinkShape,
  type LegacyLinks,
  ceremonyPath,
  ceremonyRoutePrefix,
  ceremonyRouterPath,
  invokeKind,
  isAuthenticatorInvocationKind,
  matchCeremonyPath,
} from "./ceremony-routes.js";
export {
  type ClaimLink,
  PORTABLE_DROP_TOKEN_PREFIX,
  buildClaimLink,
  fragmentCarriesBearer,
  isClaimToken,
  isPortableDropToken,
  readClaimLink,
} from "./claim-link.js";
export {
  type ClaimStash,
  type ClaimStashOptions,
  type StashStorage,
  createClaimStash,
} from "./claim-stash.js";
export {
  type ClaimRefusal,
  type ClaimRefusalKind,
  type DropRefusal,
  type DropRefusalCode,
  claimRefusal,
  dropRefusal,
} from "./claim-words.js";
export {
  parseUserCode,
  readFragmentToken,
  scrubFragment,
} from "./deep-link.js";
export {
  type ApproveDeviceInput,
  CeremonyRequestError,
  type DeviceApproval,
  approveDevice,
  deviceApprovalWords,
} from "./device.js";
export {
  type InteractionApproval,
  type InteractionApprovalDeps,
  type InteractionAssertion,
  type InteractionAuthenticator,
  type InteractionPhase,
  type InteractionStep,
  InteractionStepUpError,
  STEP_UP_WORDS,
  type StepUpFailure,
  createInteractionApproval,
} from "./interaction-approval.js";
export {
  type InteractionArrival,
  type InteractionArrivalRead,
  readInteractionArrival,
} from "./interaction-arrival.js";
export {
  type ApproveInteractionInput,
  type BeginInteractionActivationInput,
  type CompleteInteractionActivationInput,
  type DenyInteractionInput,
  type InteractionActivationChallenge,
  type InteractionActivationResult,
  type InteractionClient,
  type InteractionClientOptions,
  createInteractionClient,
} from "./interaction-client.js";
export {
  INTERACTION_ERROR_WORDS,
  InteractionError,
  type InteractionErrorCode,
} from "./interaction-error.js";
export {
  type ApprovalView,
  INTERACTION_LABELS,
  INTERACTION_WORDS,
  type InteractionRefusal,
  type InteractionRefusalKind,
  type Mechanism,
  OUTCOME_IS_REFUSAL,
  OUTCOME_MARK,
  OUTCOME_TEXT,
  type Outcome,
  chooseMechanism,
  interactionRefusal,
  outcomeOfErrorCode,
  outcomeOfStatus,
  viewOf,
} from "./interaction-outcome.js";
export {
  type RenderedInteractionSummary,
  renderInteractionSummary,
} from "./interaction-summary.js";
export {
  InteractionLinkError,
  type InteractionLinkErrorReason,
  type LegacyInteractionLink,
  assertNoForbiddenParams,
  buildCeremonyUrl,
  buildInteractionUrl,
  isInteractionRef,
  parseInteractionUrl,
  parseLegacyInteractionLink,
} from "./interaction-url.js";
export {
  INVOCATION_LABELS,
  INVOCATION_WORDS,
  type InvocationArrival,
  type InvocationArrivalRead,
  invocationKindAt,
  readInvocationArrival,
} from "./invocation-link.js";
