#!/usr/bin/env node
/**
 * Reject pushes whose commits are not SSH-signed (G) or lack recognised agent
 * attribution. A Grok claim needs a Grok or cursor[bot] author, or Grok Build
 * proof in the message. Other recognised agents are not required to claim Grok.
 *
 *   node scripts/dev/grok-commit-guard.mjs --range origin/main..HEAD
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertCommitAgentAttribution } from "../lib/agent-commit-attribution.mjs";
import { readString } from "../lib/json-boundary.mjs";

export { GROK_AUTHOR_EMAIL } from "../lib/grok-commit-identity.mjs";

const COMMIT_MARKER = "----COMMIT----";

/** Parse one `git log --format=%G? %ae` line (legacy tests). */
export function parseSignatureLogLine(line) {
  const text = line.trim();
  if (text.length === 0) {
    return undefined;
  }
  const space = text.indexOf(" ");
  if (space <= 0) {
    throw new Error(`invalid signature log line: ${text}`);
  }
  const signature = text.slice(0, space);
  const authorEmail = text.slice(space + 1);
  if (
    readString(signature) === undefined ||
    readString(authorEmail) === undefined
  ) {
    throw new Error(`invalid signature log line: ${text}`);
  }
  return { signature, authorEmail };
}

export function assertCommitSignedByGrok(entry) {
  if (entry.signature !== "G") {
    throw new Error(
      `Grok Build refuses unsigned or invalid commits (signature ${entry.signature}); configure SSH signing before committing`,
    );
  }
  const authorEmail = readString(entry.authorEmail) ?? "";
  const authorName = readString(entry.authorName) ?? "";
  const message = readString(entry.message) ?? "";
  assertCommitAgentAttribution({
    sha: entry.sha,
    commit: {
      author: { email: authorEmail, name: authorName },
      message,
      // SSH "G" is the pre-push stand-in for GitHub verification, so a signed
      // Grok or cursor[bot] author satisfies a Grok claim the way replay does.
      verification: { verified: true },
    },
  });
}

/**
 * Validate parsed commit records (empty range is OK).
 * Git log text is parsed at the I/O boundary (`parseSignatureLogLine` or
 * `gitLogRange`) before it reaches this function.
 */
export function assertGrokSignedRevisionRange(commits) {
  for (const commit of commits) {
    assertCommitSignedByGrok(commit);
  }
}

function gitLogRange(repoRoot, range) {
  const ran = spawnSync(
    "git",
    [
      "log",
      "--reverse",
      `--format=%H%n%G? %ae%n%an%n%B%n${COMMIT_MARKER}`,
      range,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  if (ran.error) {
    throw ran.error;
  }
  if (ran.status !== 0) {
    throw new Error(ran.stderr || ran.stdout || "git log failed");
  }
  const blocks = ran.stdout
    .split(COMMIT_MARKER)
    .map((block) => block.trim())
    .filter(Boolean);
  const commits = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const sha = lines.shift()?.trim();
    const sigLine = lines.shift();
    if (sha === undefined || sigLine === undefined) {
      throw new Error(`invalid git log block: ${block.slice(0, 80)}`);
    }
    const parsed = parseSignatureLogLine(sigLine);
    const authorName = lines.shift()?.trim() ?? "";
    const message = lines.join("\n").trim();
    if (parsed === undefined) {
      continue;
    }
    commits.push({
      sha,
      signature: parsed.signature,
      authorEmail: parsed.authorEmail,
      authorName,
      message,
    });
  }
  return commits;
}

function main() {
  const rangeFlag = process.argv.indexOf("--range");
  if (rangeFlag === -1 || process.argv[rangeFlag + 1] === undefined) {
    throw new Error("Usage: grok-commit-guard.mjs --range REVISION_RANGE");
  }
  const range = process.argv[rangeFlag + 1];
  assertGrokSignedRevisionRange(gitLogRange(process.cwd(), range));
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main();
}
