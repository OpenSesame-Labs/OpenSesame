export {
  AGENT_AUTH_SCOPES,
  AGENT_AUTH_SCOPE_ACTIONS,
  AGENT_AUTH_SCOPE_DESCRIPTIONS,
  type AgentAuthScope,
  DEFAULT_POST_CLAIM_SCOPES,
  DEFAULT_PRE_CLAIM_SCOPES,
  evaluateAgentAuthScopes,
  intersectAgentAuthScopes,
  isAgentAuthScope,
  parseScopeParameter,
  scopesForRegistrationState,
} from "./agent-auth-scopes.js";
export {
  IncoherentAssuranceError,
  type MechanismDecision,
  type MechanismDecisionEffect,
  type MechanismRequirement,
  assertAssuranceCoherent,
  interactionRequiresPhishingResistance,
  isPhishingResistantMechanism,
  mechanismPermittedForKind,
  mechanismSatisfies,
} from "./approval-mechanisms.js";
export * from "./authority-tuple-backfill.js";

export * from "./authority-tuples.js";
export {
  type AuthorizationDecision,
  type AuthorizationRequest,
  DEFAULT_PROVISIONAL_QUOTA,
  DEFAULT_VERIFIED_QUOTA,
  type DecisionEffect,
  ProvisionalPolicy,
  type ProvisionalQuota,
  type ProvisionalUsage,
  quotaFieldFor,
} from "./provisional.js";
