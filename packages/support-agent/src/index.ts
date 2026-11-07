/**
 * The provider-neutral support core: the port contract, the instruction
 * builder, the egress boundary, model-output handling, the session, and the
 * deterministic fake the rest of the workspace tests against.
 *
 * Nothing here imports React, a tour renderer or a vendor model SDK. A surface
 * chooses those; this package decides what may be said and what may be sent.
 */

export * from "./contract.js";
export {
  SupportEgressRefused,
  assertNoStructuralLeak,
  redactionWarning,
  sanitizeSupportRequest,
} from "./egress.js";
export {
  type FakeReplanStep,
  type FakeSupportAgent,
  type FakeSupportRule,
  type FakeSupportScript,
  createFakeSupportAgent,
  fakeAgentAlwaysUnavailable,
  fakeAgentAnswering,
  fakeAgentDownloadable,
  fakeAgentDownloading,
  fakeAgentFailing,
  fakeAgentHanging,
  fakeAgentReplanning,
  fakeSupportPageContext,
} from "./fake.js";
export {
  SUPPORT_POLICY_CLAUSES,
  buildSupportInstructions,
} from "./instructions.js";
export {
  REMOTE_PAYLOAD_BYTES,
  REMOTE_QUESTION_LIMIT,
  type RemoteSupportPayload,
  redactSupportQuestion,
  remoteSupportPayload,
} from "./remote-payload.js";
export {
  type SupportSession,
  type SupportSessionDeps,
  type SupportSessionSnapshot,
  type SupportSessionStatus,
  createSupportSession,
} from "./session.js";
export {
  type GuideCompileFailureSummary,
  type GuideCompileIssue,
  type SupportGroundedAnswer,
  type SupportGuideCompileResult,
  type SupportGuideVocabulary,
  type SupportSourcesExtraction,
  type SupportTurnOptions,
  type SupportTurnOutcome,
  type SupportTurnSeams,
  extractSupportSources,
  groundSupportAnswer,
  guideRepairInstruction,
  parseSupportTurn,
  runSupportTurn,
  supportTurnSeams,
  supportVocabulary,
} from "./turn.js";
