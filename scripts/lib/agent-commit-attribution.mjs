/**
 * Recognised agent/human attribution for PR commits (ADR: cloud agent provenance).
 * Grok Build is required only when a commit claims Grok; other agents and Tyler
 * are accepted on their own identity or co-author trailers.
 */
import {
  GROK_AUTHOR_EMAIL,
  GROK_AUTHOR_NAME,
  grokCoAuthorTrailer,
} from "./grok-commit-identity.mjs";
import { readString } from "./json-boundary.mjs";

/** @typedef {{ sha?: string; commit?: { author?: { name?: string; email?: string }; message?: string; verification?: { verified?: boolean } } }} CommitEntry */

const CLAUDE_EMAIL = /@(?:users\.)?(?:noreply\.)?anthropic\.com\b/i;
const CURSOR_BOT_EMAIL =
  /^206951365\+cursor\[bot\]@users\.noreply\.github\.com$/i;
const TYLER_EMAIL =
  /^(?:145080887\+)?Tyler-R-Kendrick@users\.noreply\.github\.com$/i;

/** Substrings that satisfy Grok Build proof when a commit claims Grok. */
const GROK_BUILD_PROOF = [
  /grok-chunk-run\.sh/i,
  /grok-headless\.sh/i,
  /work\/grok-logs\//i,
  /\bGrok-Build:/i,
  /land-signed-stack\.mjs/i,
];

const CO_AUTHOR = /^co-authored-by:\s*/im;

function message(commit) {
  return commit.commit?.message ?? "";
}

function authorEmail(commit) {
  return readString(commit.commit?.author?.email) ?? "";
}

function authorName(commit) {
  return readString(commit.commit?.author?.name) ?? "";
}

/** @returns {string[]} */
function coAuthorLines(body) {
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => CO_AUTHOR.test(line));
}

export function commitClaimsGrok(entry) {
  if (authorEmail(entry) === GROK_AUTHOR_EMAIL) return true;
  if (authorName(entry) === GROK_AUTHOR_NAME) return true;
  const trailer = grokCoAuthorTrailer();
  if (message(entry).includes(trailer)) return true;
  return coAuthorLines(message(entry)).some(
    (line) =>
      line.includes(GROK_AUTHOR_EMAIL) ||
      (line.includes(GROK_AUTHOR_NAME) && line.includes("x.ai")),
  );
}

export function grokBuildProofPresent(entry) {
  const body = message(entry);
  return GROK_BUILD_PROOF.some((pattern) => pattern.test(body));
}

/**
 * GitHub-verified replay: cursor[bot] author with Grok co-author (land-signed-stack).
 */
export function grokVerifiedReplayAttribution(entry) {
  if (entry.commit?.verification?.verified !== true) return false;
  if (!commitClaimsGrok(entry)) return false;
  if (authorEmail(entry) === GROK_AUTHOR_EMAIL) return true;
  if (CURSOR_BOT_EMAIL.test(authorEmail(entry))) return true;
  return false;
}

/** Satisfy a Grok claim: verified replay path, or explicit Grok Build proof in the message. */
export function grokClaimSatisfied(entry) {
  if (!commitClaimsGrok(entry)) return true;
  if (grokVerifiedReplayAttribution(entry)) return true;
  if (grokBuildProofPresent(entry)) return true;
  return false;
}

/**
 * @returns {'grok'|'claude'|'kimi'|'muse'|'cursor'|'tyler'|undefined}
 */
export function recognizedAgentId(entry) {
  const email = authorEmail(entry);
  const name = authorName(entry);
  const body = message(entry);
  const coAuthors = coAuthorLines(body).join("\n");

  if (
    body.includes(grokCoAuthorTrailer()) ||
    /Co-authored-by:.*Grok/i.test(body)
  )
    return "grok";
  if (email === GROK_AUTHOR_EMAIL || name === GROK_AUTHOR_NAME) return "grok";
  if (CLAUDE_EMAIL.test(email) || /claude/i.test(name)) return "claude";
  if (
    /kimi/i.test(name) ||
    /@moonshot\.ai$/i.test(email) ||
    /kimi/i.test(coAuthors)
  )
    return "kimi";
  if (/\bmuse\b/i.test(name) || /\bmuse\b/i.test(coAuthors)) return "muse";
  if (CURSOR_BOT_EMAIL.test(email) || /cursor\[bot\]/i.test(name))
    return "cursor";
  if (TYLER_EMAIL.test(email) || name === "Tyler Kendrick") return "tyler";
  if (/Co-Authored-By:.*[Cc]laude/i.test(body) || CLAUDE_EMAIL.test(coAuthors))
    return "claude";
  if (/Claude-Session:/i.test(body)) return "claude";
  if (/Co-authored-by:.*[Kk]imi/i.test(body)) return "kimi";
  if (/Co-authored-by:.*[Mm]use/i.test(body)) return "muse";

  return undefined;
}

export function commitHasRecognizedAttribution(entry) {
  return recognizedAgentId(entry) !== undefined;
}

export function assertCommitAgentAttribution(entry) {
  const agent = recognizedAgentId(entry);
  if (agent === undefined) {
    throw new Error(
      `Agent attribution required: ${entry.sha ?? "?"} (${authorName(entry)} <${authorEmail(entry)}>). ` +
        "Use a recognised author or Co-authored-by trailer (Grok, Claude, Kimi, Muse, cursor[bot], or Tyler Kendrick).",
    );
  }
  if (!grokClaimSatisfied(entry)) {
    throw new Error(
      `Grok attribution requires Grok Build proof: ${entry.sha ?? "?"}. ` +
        "Include grok-chunk-run/grok-headless log path, land-signed-stack replay, or Grok-Build: … in the message.",
    );
  }
}
