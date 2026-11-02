/**
 * Block Preview until this commit has a completed successful main push of
 * `.github/workflows/ci.yml`, and that run's required checks succeeded.
 *
 *   GH_TOKEN=... GITHUB_REPOSITORY=owner/name GITHUB_SHA=<40 hex> \
 *     node scripts/release/cd-main-ci-gate.mjs
 *
 * Merge-queue contexts stay TypeScript, Rust, and Bundle budgets. This gate
 * reads them. It does not drop or rename them.
 */
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { isJsonObject, readString } from "../lib/json-boundary.mjs";

export const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";
export const REQUIRED_CHECK_NAMES = Object.freeze([
  "TypeScript",
  "Rust",
  "Bundle budgets",
]);

const API = "https://api.github.com";

function isPositiveInteger(value) {
  return (
    Object(value) !== value &&
    Object.prototype.toString.call(value) === "[object Number]" &&
    Number.isInteger(value) &&
    value > 0
  );
}

function requireText(value, label) {
  const text = readString(value);
  if (text === undefined || text.length === 0) {
    throw new Error(`${label} is required`);
  }
  return text;
}

function readCount(value, fallback, label) {
  if (value === undefined || value === "") return fallback;
  const text = readString(value);
  if (text === undefined || !/^[1-9]\d*$/u.test(text)) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Number(text);
}

function readDelay(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const text = readString(value);
  if (text === undefined || !/^\d+$/u.test(text)) {
    throw new Error(
      "CI_GATE_INTERVAL_MS must be a whole number of milliseconds",
    );
  }
  return Number(text);
}

export function readGateConfig(env) {
  const token = readString(env.GH_TOKEN) ?? readString(env.GITHUB_TOKEN);
  if (token === undefined || token.length === 0) {
    throw new Error("GH_TOKEN or GITHUB_TOKEN is required");
  }
  const repository = requireText(env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error("GITHUB_REPOSITORY must be owner/name");
  }
  const sha = requireText(env.GITHUB_SHA, "GITHUB_SHA");
  if (!/^[0-9a-f]{40}$/u.test(sha)) {
    throw new Error("GITHUB_SHA must be 40 lowercase hex characters");
  }
  return {
    token,
    repository,
    sha,
    attempts: readCount(env.CI_GATE_ATTEMPTS, 80, "CI_GATE_ATTEMPTS"),
    intervalMs: readDelay(env.CI_GATE_INTERVAL_MS, 30_000),
  };
}

function sameCommit(run, sha, repository) {
  if (!isJsonObject(run)) return false;
  if (!isJsonObject(run.head_repository)) return false;
  return (
    run.path === CI_WORKFLOW_PATH &&
    run.event === "push" &&
    run.head_branch === "main" &&
    run.head_sha === sha &&
    run.head_repository.full_name === repository
  );
}

/** Successful main push of ci.yml for this commit, from one API page of runs. */
export function classifyRuns(runs, sha, repository) {
  if (!Array.isArray(runs)) throw new Error("workflow run list is incomplete");
  const successful = [];
  let completedFailure = false;
  let pending = false;
  for (const run of runs) {
    if (!sameCommit(run, sha, repository)) continue;
    if (run.status === "completed" && run.conclusion === "success") {
      successful.push(run);
    } else if (run.status === "completed") {
      completedFailure = true;
    } else {
      pending = true;
    }
  }
  return { successful, completedFailure, pending };
}

export function readRunId(run) {
  if (!isJsonObject(run)) throw new Error("workflow run id is missing");
  if (isPositiveInteger(run.id)) return String(run.id);
  const text = readString(run.id);
  if (text !== undefined && /^[1-9]\d*$/u.test(text)) return text;
  throw new Error("workflow run id is missing");
}

/**
 * Required check names must each have a completed successful job on this run.
 * A skip is not success. Extra jobs do not satisfy a missing name.
 */
export function failedChecks(jobs) {
  if (!Array.isArray(jobs)) throw new Error("job list is incomplete");
  const found = new Map();
  for (const job of jobs) {
    if (!isJsonObject(job)) continue;
    const name = readString(job.name);
    if (name === undefined) continue;
    found.set(name, job);
  }
  const problems = [];
  for (const name of REQUIRED_CHECK_NAMES) {
    const job = found.get(name);
    if (job === undefined) {
      problems.push(`${name} missing`);
      continue;
    }
    const status = readString(job.status) ?? "missing";
    const conclusion = readString(job.conclusion) ?? "missing";
    if (status !== "completed" || conclusion !== "success") {
      problems.push(`${name} ${status}/${conclusion}`);
    }
  }
  return problems;
}

async function githubGet(url, token, fetcher) {
  const response = await fetcher(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "opensesame-cd-main-ci-gate",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "error",
  });
  if (!response.ok) {
    const path = new URL(url).pathname;
    throw new Error(
      `GitHub API ${response.status} for ${path} (actions: read is required)`,
    );
  }
  return response.json();
}

function readRunPage(payload) {
  if (!isJsonObject(payload) || !Array.isArray(payload.workflow_runs)) {
    throw new Error("workflow run list is incomplete");
  }
  return payload.workflow_runs;
}

function readJobPage(payload) {
  if (!isJsonObject(payload) || !Array.isArray(payload.jobs)) {
    throw new Error("job list is incomplete");
  }
  return payload.jobs;
}

async function listRuns(config, fetcher) {
  const runs = [];
  for (let page = 1; page <= 5; page += 1) {
    const url =
      `${API}/repos/${config.repository}/actions/workflows/ci.yml/runs` +
      `?head_sha=${config.sha}&branch=main&event=push&per_page=100&page=${page}`;
    const pageRuns = readRunPage(await githubGet(url, config.token, fetcher));
    runs.push(...pageRuns);
    if (pageRuns.length < 100) return runs;
  }
  throw new Error("workflow run list exceeded 5 pages");
}

async function listJobs(config, runId, fetcher) {
  const jobs = [];
  for (let page = 1; page <= 5; page += 1) {
    const url =
      `${API}/repos/${config.repository}/actions/runs/${runId}/jobs` +
      `?per_page=100&page=${page}`;
    const pageJobs = readJobPage(await githubGet(url, config.token, fetcher));
    jobs.push(...pageJobs);
    if (pageJobs.length < 100) return jobs;
  }
  throw new Error("job list exceeded 5 pages");
}

export async function waitForMainCi(config, fetcher, sleep) {
  let lastProblem = `no completed successful ${CI_WORKFLOW_PATH} push on main`;
  for (let attempt = 1; attempt <= config.attempts; attempt += 1) {
    const classified = classifyRuns(
      await listRuns(config, fetcher),
      config.sha,
      config.repository,
    );
    for (const run of classified.successful) {
      const problems = failedChecks(
        await listJobs(config, readRunId(run), fetcher),
      );
      if (problems.length === 0) {
        return { runId: readRunId(run), sha: config.sha };
      }
      lastProblem = problems.join("; ");
    }
    if (
      classified.completedFailure &&
      classified.successful.length === 0 &&
      !classified.pending
    ) {
      throw new Error(
        `main CI failed for ${config.sha}: ci.yml push completed without success`,
      );
    }
    if (classified.successful.length > 0 && !classified.pending) {
      throw new Error(`main CI failed for ${config.sha}: ${lastProblem}`);
    }
    if (attempt === config.attempts) break;
    await sleep(config.intervalMs);
  }
  throw new Error(`main CI did not succeed for ${config.sha}: ${lastProblem}`);
}

async function main() {
  const config = readGateConfig(process.env);
  const admitted = await waitForMainCi(config, fetch, delay);
  console.log(
    `main CI passed for ${admitted.sha} on run ${admitted.runId} (${REQUIRED_CHECK_NAMES.join(", ")})`,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    const message =
      error instanceof Error ? error.message : "main CI gate failed";
    console.error(message);
    process.exit(1);
  });
}
