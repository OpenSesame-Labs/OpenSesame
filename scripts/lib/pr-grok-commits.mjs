/**
 * Backward-compatible exports; PR CI uses agent attribution, not Grok-only.
 */
export {
  appendGrokCoAuthorTrailer,
  grokCoAuthorTrailer,
} from "./grok-commit-identity.mjs";
export {
  assertCommitAgentAttribution,
  assertPrAgentAttribution,
  assertPrAgentAttribution as assertPrGrokCommits,
  commitHasRecognizedAttribution,
  commitHasRecognizedAttribution as commitAttributesGrok,
} from "./pr-agent-attribution.mjs";
