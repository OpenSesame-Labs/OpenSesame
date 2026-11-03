import {
  GROK_AUTHOR_EMAIL,
  GROK_AUTHOR_NAME,
  appendGrokCoAuthorTrailer,
  grokCoAuthorTrailer,
} from "./grok-commit-identity.mjs";
import { assertPrSignatures } from "./pr-signatures.mjs";

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

/** Match Grok Build + ruleset: GitHub-verified and Grok-attributed. */
export function assertPrGrokCommits(pr, commits, expectedHead) {
  assertPrSignatures(pr, commits, expectedHead);
  const wrongAuthor = commits.filter((entry) => !commitAttributesGrok(entry));
  if (wrongAuthor.length) {
    throw new Error(
      `Grok-attributed commits required: ${wrongAuthor
        .map(
          (entry) =>
            `${entry.sha} (${entry.commit?.author?.name ?? "?"} <${entry.commit?.author?.email ?? "?"}>)`,
        )
        .join(
          ", ",
        )}. Author as Grok <${GROK_AUTHOR_EMAIL}> or include ${grokCoAuthorTrailer()} in the message.`,
    );
  }
}

export { appendGrokCoAuthorTrailer, grokCoAuthorTrailer };
