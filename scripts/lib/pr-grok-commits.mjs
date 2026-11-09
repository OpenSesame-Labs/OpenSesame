import {
  GROK_AUTHOR_EMAIL,
  GROK_AUTHOR_NAME,
  grokCoAuthorTrailer,
} from "./grok-commit-identity.mjs";

/**
 * Whether a commit is attributed to Grok (author, or a Co-authored-by trailer).
 *
 * Used by the Grok replay tool (`scripts/release/land-signed-stack.mjs`) to check
 * the commits it creates. It is NOT a pull-request gate: nothing requires a
 * commit to involve Grok. The PR gate checks signatures only
 * (`scripts/lib/pr-signatures.mjs`).
 */
export function commitAttributesGrok(entry) {
  const author = entry.commit?.author;
  if (
    author?.email === GROK_AUTHOR_EMAIL &&
    author?.name === GROK_AUTHOR_NAME
  ) {
    return true;
  }
  const message = entry.commit?.message ?? "";
  return message.includes(grokCoAuthorTrailer());
}
