/** Author identity for Grok Build commits (local git and GitHub replay). */
export const GROK_AUTHOR_NAME = "Grok";
export const GROK_AUTHOR_EMAIL = "noreply@x.ai";

/** Append the Grok Build attribution trailer for GitHub replay commits. */
export function grokCoAuthorTrailer() {
  return `Co-authored-by: ${GROK_AUTHOR_NAME} <${GROK_AUTHOR_EMAIL}>`;
}

export function appendGrokCoAuthorTrailer(body) {
  const trailer = grokCoAuthorTrailer();
  if (body.includes(trailer)) {
    return body;
  }
  if (body.length === 0) {
    return trailer;
  }
  return `${body}\n\n${trailer}`;
}
