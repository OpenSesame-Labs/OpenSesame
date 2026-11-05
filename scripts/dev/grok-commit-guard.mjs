#!/usr/bin/env node
/**
 * Reject pushes whose commits are not Grok-attributed and signed.
 *
 * A commit passes when `%G?` is `G` and the author email is Grok's, or when
 * GitHub reports `commit.verification.verified` and `commitAttributesGrok`
 * accepts the commit. Replay commits are authored by cursor[bot]; their local
 * `%G?` is `E` because GitHub's signature is not in the local keyring.
 *
 *   node scripts/dev/grok-commit-guard.mjs --range origin/main..HEAD
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { GROK_AUTHOR_EMAIL } from "../lib/grok-commit-identity.mjs";
import { isJsonObject, readString } from "../lib/json-boundary.mjs";
import { commitAttributesGrok } from "../lib/pr-grok-commits.mjs";

export { GROK_AUTHOR_EMAIL } from "../lib/grok-commit-identity.mjs";

const SIGNATURE_LOG_FORMAT = "%H %G? %ae";
const SIGNATURE_LINE = /^([0-9a-f]{40}) ([A-Za-z]) (\S+)$/;
const OWNER_REPO = /^[\w.-]+\/[\w.-]+$/;
const SHA = /^[0-9a-f]{40}$/;

/** Parse one `git log --format=%H %G? %ae` line. */
export function parseSignatureLogLine(line) {
  const text = line.trim();
  if (text.length === 0) {
    return undefined;
  }
  const match = SIGNATURE_LINE.exec(text);
  if (match === null) {
    throw new Error(`invalid signature log line: ${text}`);
  }
  const sha = match[1];
  const signature = match[2];
  const authorEmail = match[3];
  if (
    readString(sha) === undefined ||
    readString(signature) === undefined ||
    readString(authorEmail) === undefined
  ) {
    throw new Error(`invalid signature log line: ${text}`);
  }
  return { sha, signature, authorEmail };
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

function redactRemote(remoteUrl) {
  const trimmed = remoteUrl.trim();
  try {
    const url = new URL(trimmed);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return trimmed.replace(/\/\/[^/\s@]+@/g, "//");
  }
}

function refuseRemote(remoteUrl) {
  throw new Error(
    `Grok Build cannot resolve owner/repo from origin (${redactRemote(remoteUrl)})`,
  );
}

function githubRemoteUrl(remoteUrl) {
  try {
    return new URL(remoteUrl);
  } catch {
    return refuseRemote(remoteUrl);
  }
}

/** `owner/repo` from an `origin` URL. Userinfo is never returned. */
export function parseGithubOwnerRepo(remoteUrl) {
  const trimmed = remoteUrl.trim();
  const scp = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(trimmed);
  if (scp !== null) {
    return ownerRepo(scp[1], scp[2], trimmed);
  }
  const url = githubRemoteUrl(trimmed);
  if (url.hostname !== "github.com") {
    return refuseRemote(trimmed);
  }
  const parts = url.pathname.split("/").filter((part) => part.length > 0);
  const owner = parts[0];
  const repo = parts[1];
  if (parts.length !== 2 || owner === undefined || repo === undefined) {
    return refuseRemote(trimmed);
  }
  return ownerRepo(owner, repo.replace(/\.git$/, ""), trimmed);
}

function ownerRepo(owner, repo, remoteUrl) {
  const repository = `${owner}/${repo}`;
  if (!OWNER_REPO.test(repository)) {
    return refuseRemote(remoteUrl);
  }
  return repository;
}

function run(command, args, cwd) {
  const ran = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (ran.error) {
    throw ran.error;
  }
  if (ran.status !== 0) {
    throw new Error((ran.stderr || ran.stdout || `${command} failed`).trim());
  }
  return ran.stdout;
}

function resolveOriginRepository(repoRoot) {
  return parseGithubOwnerRepo(
    run("git", ["remote", "get-url", "origin"], repoRoot),
  );
}

function parseGithubCommitResponse(stdout, sha) {
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new Error(`GitHub commit ${sha} response was not JSON`);
  }
  if (!isJsonObject(payload)) {
    throw new Error(`GitHub commit ${sha} response was not an object`);
  }
  return payload;
}

/** Fetch one commit from `gh api repos/{owner}/{repo}/commits/{sha}`. */
export function lookupVerifiedGithubCommit(sha, repoRoot = process.cwd()) {
  if (!SHA.test(sha)) {
    throw new Error(`invalid commit sha: ${sha}`);
  }
  const repository = resolveOriginRepository(repoRoot);
  const stdout = run(
    "gh",
    ["api", `repos/${repository}/commits/${sha}`],
    repoRoot,
  );
  return parseGithubCommitResponse(stdout, sha);
}

function githubReplayAccepted(entry, payload) {
  if (!isJsonObject(payload) || readString(payload.sha) !== entry.sha) {
    return false;
  }
  const commit = payload.commit;
  if (!isJsonObject(commit)) {
    return false;
  }
  const verification = commit.verification;
  if (!isJsonObject(verification) || verification.verified !== true) {
    return false;
  }
  return commitAttributesGrok(payload);
}

function errorDetail(error) {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return "unknown failure";
}

function assertPushCommit(entry, lookupCommit) {
  if (entry.signature === "G" && entry.authorEmail === GROK_AUTHOR_EMAIL) {
    assertCommitSignedByGrok(entry);
    return;
  }
  let payload;
  try {
    payload = lookupCommit(entry.sha);
  } catch (error) {
    throw new Error(
      `Grok Build refuses commit ${entry.sha}: GitHub verification lookup failed (${errorDetail(error)})`,
    );
  }
  if (!githubReplayAccepted(entry, payload)) {
    throw new Error(
      `Grok Build refuses commit ${entry.sha}: GitHub signature is not verified or the commit is not Grok-attributed (local signature ${entry.signature})`,
    );
  }
}

/**
 * Validate every commit in a git revision range (empty range is OK).
 * `lookupCommit` defaults to the live `gh` lookup; tests pass a fake.
 */
export function assertGrokSignedRevisionRange(
  gitLogLines,
  lookupCommit = lookupVerifiedGithubCommit,
) {
  for (const line of gitLogLines) {
    const parsed = parseSignatureLogLine(line);
    if (parsed === undefined) {
      continue;
    }
    assertPushCommit(parsed, lookupCommit);
  }
}

function gitLogRange(repoRoot, range) {
  return run(
    "git",
    ["log", `--format=${SIGNATURE_LOG_FORMAT}`, range],
    repoRoot,
  ).split("\n");
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
