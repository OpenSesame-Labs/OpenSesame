#!/usr/bin/env node
/**
 * Admit a release-candidate source revision before any job checks it out.
 *
 * Reusable qualification workflows receive `source_sha` from the candidate
 * controller. A workflow_run on `main` can also be raised by a fork branch
 * that happens to be named `main`, and GitHub serves fork commits through the
 * base repository, so a caller-supplied SHA alone is not proof of review.
 * This step admits only a full 40-hex commit that is already an ancestor of
 * (or equal to) the repository's default branch, i.e. reviewed and merged
 * code, and publishes it as the step output `revision`. The candidate
 * checkout reads that output, never the raw input.
 *
 * Runs from the trusted helper checkout (the workflow SHA) with only the
 * runner's Node, `gh` and `scripts/lib/json-boundary.mjs`; it reads
 * REQUESTED_SOURCE, GITHUB_REPOSITORY and GITHUB_OUTPUT from the environment,
 * and GH_TOKEN for `gh`.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { isString } from "../lib/json-boundary.mjs";

const FULL_SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;
const BRANCH = /^[\w][\w./-]{0,254}$/;

/**
 * Decide from the compare of `candidate...defaultBranch` (base = candidate).
 * The candidate is an ancestor exactly when it is the merge base and the
 * default branch is not behind it.
 */
export function admitCandidateSource({ candidate, defaultBranch, compare }) {
  if (!isString(candidate) || !FULL_SHA.test(candidate))
    throw new Error("The candidate source must be a full 40-hex commit SHA.");
  if (!isString(defaultBranch) || !BRANCH.test(defaultBranch))
    throw new Error("The repository default branch is not a plain branch.");
  const mergeBase = compare?.merge_base_commit?.sha;
  if (
    mergeBase !== candidate ||
    compare?.behind_by !== 0 ||
    !["ahead", "identical"].includes(compare?.status)
  )
    throw new Error(
      `Candidate ${candidate} is not on ${defaultBranch}; refusing to check it out.`,
    );
  return candidate;
}

function api(path) {
  return JSON.parse(
    execFileSync("gh", ["api", path], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    }),
  );
}

export function main(env = process.env, request = api) {
  const repository = env.GITHUB_REPOSITORY ?? "";
  const candidate = env.REQUESTED_SOURCE ?? "";
  const output = env.GITHUB_OUTPUT ?? "";
  if (!REPOSITORY.test(repository) || output === "")
    throw new Error("GITHUB_REPOSITORY and GITHUB_OUTPUT are required.");
  if (!FULL_SHA.test(candidate))
    throw new Error("The candidate source must be a full 40-hex commit SHA.");
  const defaultBranch = request(`repos/${repository}`).default_branch;
  if (!isString(defaultBranch) || !BRANCH.test(defaultBranch))
    throw new Error("The repository default branch is not a plain branch.");
  const compare = request(
    `repos/${repository}/compare/${candidate}...${encodeURIComponent(defaultBranch)}?per_page=1`,
  );
  const revision = admitCandidateSource({ candidate, defaultBranch, compare });
  appendFileSync(output, `revision=${revision}\n`);
  console.log(`Admitted ${revision}: already on ${defaultBranch}.`);
  return revision;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
