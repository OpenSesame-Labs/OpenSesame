#!/usr/bin/env node
/**
 * Reject pushes whose commits are not SSH-signed (G) or not authored by Grok.
 *
 *   node scripts/dev/grok-commit-guard.mjs --range origin/main..HEAD
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { GROK_AUTHOR_EMAIL } from "../lib/grok-commit-identity.mjs";
import { readString } from "../lib/json-boundary.mjs";

export { GROK_AUTHOR_EMAIL } from "../lib/grok-commit-identity.mjs";

/** Parse one `git log --format=%G? %ae` line. */
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
  if (entry.authorEmail !== GROK_AUTHOR_EMAIL) {
    throw new Error(
      `Grok Build refuses commits not authored by Grok <${GROK_AUTHOR_EMAIL}> (got ${entry.authorEmail})`,
    );
  }
}

/** Validate every commit in a git revision range (empty range is OK). */
export function assertGrokSignedRevisionRange(gitLogLines) {
  for (const line of gitLogLines) {
    const parsed = parseSignatureLogLine(line);
    if (parsed === undefined) {
      continue;
    }
    assertCommitSignedByGrok(parsed);
  }
}

function gitLogRange(repoRoot, range) {
  const ran = spawnSync("git", ["log", "--format=%G? %ae", range], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (ran.error) {
    throw ran.error;
  }
  if (ran.status !== 0) {
    throw new Error(ran.stderr || ran.stdout || "git log failed");
  }
  return ran.stdout.split("\n");
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
