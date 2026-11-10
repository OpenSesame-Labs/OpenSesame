import {
  assertCommitAgentAttribution,
  commitHasRecognizedAttribution,
} from "./agent-commit-attribution.mjs";
import { assertPrSignatures } from "./pr-signatures.mjs";

/** Match ruleset: GitHub-verified with recognised agent/human attribution. */
export function assertPrAgentAttribution(pr, commits, expectedHead) {
  assertPrSignatures(pr, commits, expectedHead);
  for (const entry of commits) {
    assertCommitAgentAttribution(entry);
  }
}

export { assertCommitAgentAttribution, commitHasRecognizedAttribution };
