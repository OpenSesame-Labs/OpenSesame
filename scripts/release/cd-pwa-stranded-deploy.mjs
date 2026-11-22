#!/usr/bin/env node
/**
 * Detect when live Pages release.json lags main with PWA-relevant commits
 * that path filters skipped, so CD PWA can be dispatched without loosening
 * cd-main-ci-gate.mjs.
 *
 *   PAGES_CANONICAL_ORIGIN=... GITHUB_SHA=<40 hex> \
 *     node scripts/release/cd-pwa-stranded-deploy.mjs
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isJsonObject, readString } from "../lib/json-boundary.mjs";
import { workflowPathFilters } from "../quality/cd-pwa-workspace-paths-gate.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RELEASE_FORMAT = "opensesame-pages-release";

function requireSha(value, label) {
  const text = readString(value);
  if (text === undefined || !/^[0-9a-f]{40}$/u.test(text)) {
    throw new Error(`${label} must be 40 lowercase hex characters`);
  }
  return text;
}

function requireOrigin(value) {
  const text = readString(value);
  if (text === undefined || text.length === 0) {
    throw new Error("PAGES_CANONICAL_ORIGIN is required");
  }
  const url = new URL(text);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("PAGES_CANONICAL_ORIGIN must be a clean HTTPS URL");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

export function parseReleaseManifest(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Live release.json is not valid JSON");
  }
  if (!isJsonObject(parsed))
    throw new Error("Live release.json is not an object");
  if (parsed.format !== RELEASE_FORMAT || parsed.version !== 1) {
    throw new Error("Live release.json has unexpected format");
  }
  return requireSha(parsed.revision, "Live release.json revision");
}

export function pagesDeployBase(origin, viteBase = "/") {
  const originUrl = requireOrigin(origin);
  const basePath = readString(viteBase) ?? "/";
  const joined = new URL(
    basePath.startsWith("/") ? basePath : `/${basePath}`,
    originUrl,
  );
  if (!joined.pathname.endsWith("/")) joined.pathname += "/";
  return joined;
}

export function releaseJsonUrl(origin, viteBase) {
  return new URL("release.json", pagesDeployBase(origin, viteBase));
}

export async function fetchDeployedRevision(
  origin,
  fetchImpl = fetch,
  viteBase = "/",
) {
  const response = await fetchImpl(releaseJsonUrl(origin, viteBase), {
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new Error(`Release probe HTTP ${response.status}`);
  }
  const text = await response.text();
  if (text.length > 4096) throw new Error("Release probe response too large");
  return parseReleaseManifest(text);
}

export function cdPwaPathFilters(repoRoot = root) {
  const workflow = readFileSync(
    join(repoRoot, ".github/workflows/cd-pwa.yml"),
    "utf8",
  );
  const filters = workflowPathFilters(workflow);
  return filters.filter((pattern) => !pattern.startsWith("!"));
}

export function gitDiffNameOnly(base, head, pathFilters, gitRunner = git) {
  if (base === head) return "";
  if (pathFilters.length === 0) return "";
  return gitRunner([
    "diff",
    "--name-only",
    `${base}..${head}`,
    "--",
    ...pathFilters,
  ]);
}

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

export function strandedDeployNeeded({
  githubSha,
  deployedRevision,
  pathFilters,
  gitRunner,
}) {
  const sha = requireSha(githubSha, "GITHUB_SHA");
  const deployed = requireSha(deployedRevision, "deployedRevision");
  if (deployed === sha) return false;
  const diff = gitDiffNameOnly(deployed, sha, pathFilters, gitRunner);
  return diff.length > 0;
}

export async function evaluateStrandedDeploy(env, deps = {}) {
  const sha = requireSha(env.GITHUB_SHA, "GITHUB_SHA");
  const origin = readString(env.PAGES_CANONICAL_ORIGIN);
  if (origin === undefined) {
    throw new Error("PAGES_CANONICAL_ORIGIN is required");
  }
  const viteBase = readString(env.VITE_BASE) ?? "/";

  let deployed;
  const injected = readString(env.CD_PWA_STRANDED_DEPLOYED_REVISION);
  if (injected !== undefined) {
    deployed = requireSha(injected, "CD_PWA_STRANDED_DEPLOYED_REVISION");
  } else {
    const fetchImpl = deps.fetchImpl ?? fetch;
    deployed = await fetchDeployedRevision(origin, fetchImpl, viteBase);
  }

  const pathFilters =
    deps.pathFilters ?? cdPwaPathFilters(deps.repoRoot ?? root);
  const gitRunner = deps.gitRunner ?? git;
  const injectDiff = readString(env.CD_PWA_STRANDED_DIFF_OUTPUT);
  const before = readString(env.GITHUB_EVENT_BEFORE);
  const zeroBefore = before !== undefined && /^0{40}$/u.test(before);
  const pushTriggersCdPwa =
    before !== undefined &&
    !zeroBefore &&
    gitDiffNameOnly(before, sha, pathFilters, gitRunner).length > 0;

  const stranded =
    injectDiff !== undefined
      ? injectDiff.length > 0
      : strandedDeployNeeded({
          githubSha: sha,
          deployedRevision: deployed,
          pathFilters,
          gitRunner,
        });

  const needed = stranded && !pushTriggersCdPwa;

  const status = needed ? "deploy-needed" : "up-to-date";
  return { status, deployedRevision: deployed, deployNeeded: needed };
}

function writeGithubOutput(env, deployNeeded) {
  const path = readString(env.GITHUB_OUTPUT);
  if (path === undefined || path.length === 0) return;
  appendFileSync(
    path,
    `deploy_needed=${deployNeeded ? "true" : "false"}\n`,
    "utf8",
  );
}

async function main() {
  const result = await evaluateStrandedDeploy(process.env);
  writeGithubOutput(process.env, result.deployNeeded);
  console.log(`cd-pwa-stranded: ${result.status}`);
  if (result.deployNeeded) {
    console.log(
      `cd-pwa-stranded: live revision ${result.deployedRevision} lags ${process.env.GITHUB_SHA} on PWA paths`,
    );
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
