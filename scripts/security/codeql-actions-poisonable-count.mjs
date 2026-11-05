#!/usr/bin/env node
/**
 * Count CodeQL `actions/cache-poisoning/poisonable-step` findings.
 *
 * `--profile codeql` (the default) builds a minimal Actions database from
 * `.github/workflows` plus a minimal `package.json`, then runs that query
 * from the installed `codeql/actions-queries` pack. `CODEQL_HOME` defaults
 * to `/home/ubuntu/codeql-cli`.
 *
 * `--profile privileged-caller` runs that same scan. While copying workflows
 * it overlays `.github/workflows/release-weekly.yml` from git revision
 * `37730abfa` and omits workflow files matching `*qualify*.yml`.
 *
 * `--profile github-open` does not run CodeQL. It loads
 * `tools/security/codeql-poisonable-step-github-open.json` and sums every
 * workflow file in that open-alert baseline.
 *
 * `--workflow <basename.yml>` limits `total` and `byFile` to one workflow basename.
 * Prints `{ "total": number, "byFile": { "<basename>.yml": number } }`.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isJsonObject, isString, readString } from "../lib/json-boundary.mjs";

const QUERY_ID = "actions/cache-poisoning/poisonable-step";
const DEFAULT_CODEQL_HOME = "/home/ubuntu/codeql-cli";
const PROFILE_CODEQL = "codeql";
const PROFILE_GITHUB_OPEN = "github-open";
const PROFILE_PRIVILEGED_CALLER = "privileged-caller";
const PRIVILEGED_WEEKLY_SPEC = "37730abfa:.github/workflows/release-weekly.yml";
const GITHUB_OPEN_BASELINE = join(
  "tools",
  "security",
  "codeql-poisonable-step-github-open.json",
);
const EXEC_STDERR_LIMIT = 1024 * 1024;

export function repoRootFromHere() {
  return fileURLToPath(new URL("../..", import.meta.url));
}

/** @param {unknown} sarif */
export function summarizeSarif(sarif) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  const runs =
    isJsonObject(sarif) && Array.isArray(sarif.runs) ? sarif.runs : [];
  for (const run of runs) {
    const results =
      isJsonObject(run) && Array.isArray(run.results) ? run.results : [];
    for (const result of results) {
      const uri = resultLocationUri(result);
      const file = basename(uri || "unknown");
      counts.set(file, (counts.get(file) ?? 0) + 1);
    }
  }
  return summaryFromCounts(counts);
}

/**
 * @param {Map<string, number>} counts
 * @returns {{ total: number, byFile: Record<string, number> }}
 */
function summaryFromCounts(counts) {
  const byFile = {};
  for (const file of [...counts.keys()].sort()) byFile[file] = counts.get(file);
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  return { total, byFile };
}

/** @param {unknown} result */
function resultLocationUri(result) {
  if (!isJsonObject(result) || !Array.isArray(result.locations)) return "";
  for (const location of result.locations) {
    if (!isJsonObject(location)) continue;
    const physicalLocation = location.physicalLocation;
    if (!isJsonObject(physicalLocation)) continue;
    const artifactLocation = physicalLocation.artifactLocation;
    if (!isJsonObject(artifactLocation)) continue;
    const uri = readString(artifactLocation.uri);
    if (uri !== undefined && uri.length > 0) return uri;
  }
  return "";
}

/**
 * @param {string} codeqlHome
 * @returns {string}
 */
export function poisonableStepQueryPath(codeqlHome) {
  const packRoot = join(codeqlHome, "qlpacks", "codeql", "actions-queries");
  /** @type {string[]} */
  const found = [];
  const visit = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".codeql") continue;
        visit(path);
        continue;
      }
      if (!entry.name.endsWith(".ql")) continue;
      const text = readFileSync(path, "utf8");
      if (text.includes(`@id ${QUERY_ID}`)) found.push(path);
    }
  };
  visit(packRoot);
  if (found.length === 0) {
    throw new Error(
      `query ${QUERY_ID} not found under ${packRoot} (CODEQL_HOME=${codeqlHome})`,
    );
  }
  found.sort();
  return found[found.length - 1];
}

/**
 * @param {string} repoRoot
 * @param {string} sourceRoot
 * @param {string} profile
 */
export function stageWorkflows(repoRoot, sourceRoot, profile) {
  const workflowsDir = join(sourceRoot, ".github", "workflows");
  const privileged = profile === PROFILE_PRIVILEGED_CALLER;
  mkdirSync(workflowsDir, { recursive: true });
  cpSync(join(repoRoot, ".github", "workflows"), workflowsDir, {
    recursive: true,
    filter: (source) => {
      const name = basename(source);
      const qualifyWorkflow = name.includes("qualify") && name.endsWith(".yml");
      return name !== ".git" && !(privileged && qualifyWorkflow);
    },
  });
  if (!privileged) return;
  writeFileSync(
    join(workflowsDir, "release-weekly.yml"),
    execFileSync("git", ["show", PRIVILEGED_WEEKLY_SPEC], { cwd: repoRoot }),
  );
}

/**
 * @param {{ repoRoot?: string, codeqlHome?: string, keepWork?: boolean, profile?: string }} [options]
 * @returns {{ total: number, byFile: Record<string, number> }}
 */
export function countPoisonableSteps(options = {}) {
  const repoRoot = options.repoRoot ?? repoRootFromHere();
  const codeqlHome =
    options.codeqlHome ?? process.env.CODEQL_HOME ?? DEFAULT_CODEQL_HOME;
  const codeql = join(codeqlHome, "codeql");
  const query = poisonableStepQueryPath(codeqlHome);
  const work = mkdtempSync(join(tmpdir(), "codeql-actions-poison-"));
  const sourceRoot = join(work, "src");
  const database = join(work, "db");
  const sarifPath = join(work, "poisonable-step.sarif");
  try {
    stageWorkflows(repoRoot, sourceRoot, options.profile ?? PROFILE_CODEQL);
    writeFileSync(
      join(sourceRoot, "package.json"),
      `${JSON.stringify({ name: "codeql-actions-db", private: true })}\n`,
    );
    const env = {
      ...process.env,
      CODEQL_ALLOW_INSTALLATION_ANYWHERE: "true",
      CODEQL_HOME: codeqlHome,
    };
    execFileSync(
      codeql,
      [
        "database",
        "create",
        "--language=actions",
        `--source-root=${sourceRoot}`,
        "--threads=0",
        database,
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    execFileSync(
      codeql,
      [
        "database",
        "analyze",
        "--format=sarif-latest",
        `--output=${sarifPath}`,
        "--threads=0",
        "--",
        database,
        query,
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    return summarizeSarif(JSON.parse(readFileSync(sarifPath, "utf8")));
  } finally {
    if (!options.keepWork) rmSync(work, { recursive: true, force: true });
  }
}

/**
 * A non-negative integer from JSON, or `undefined` when the value is not one.
 * @param {unknown} value
 */
function readOpenAlertCount(value) {
  if (Object(value) === value) return undefined;
  if (Object.prototype.toString.call(value) !== "[object Number]") {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 0) return undefined;
  return value;
}

/**
 * Sum the recorded GitHub open-alert inventory. Does not run CodeQL.
 * @param {unknown} document
 * @returns {{ total: number, byFile: Record<string, number> }}
 */
export function summarizeGithubOpenBaseline(document) {
  if (!isJsonObject(document) || !Array.isArray(document.inventory)) {
    throw new Error("github-open baseline is missing an inventory array");
  }
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const [index, entry] of document.inventory.entries()) {
    if (!isJsonObject(entry)) {
      throw new Error(`github-open inventory[${index}] is not an object`);
    }
    const workflow = readString(entry.workflow);
    const openAlerts = readOpenAlertCount(entry.openAlerts);
    if (
      workflow === undefined ||
      workflow.length === 0 ||
      openAlerts === undefined
    ) {
      throw new Error(
        `github-open inventory[${index}] needs a workflow name and a non-negative openAlerts count`,
      );
    }
    counts.set(workflow, (counts.get(workflow) ?? 0) + openAlerts);
  }
  return summaryFromCounts(counts);
}

/**
 * @param {string} [repoRoot]
 * @returns {{ total: number, byFile: Record<string, number> }}
 */
export function countGithubOpenAlerts(repoRoot = repoRootFromHere()) {
  const path = join(repoRoot, GITHUB_OPEN_BASELINE);
  const document = JSON.parse(readFileSync(path, "utf8"));
  return summarizeGithubOpenBaseline(document);
}

/** A workflow filename: no directory, no traversal, `.yml` or `.yaml`. */
const WORKFLOW_BASENAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/u;

/**
 * @param {string} value
 * @returns {boolean}
 */
export function isWorkflowBasename(value) {
  if (value !== basename(value)) return false;
  if (value.includes("\\") || value.includes("..")) return false;
  return WORKFLOW_BASENAME.test(value);
}

/**
 * @param {string | undefined} value
 * @returns {"codeql" | "github-open" | "privileged-caller"}
 */
function readProfile(value) {
  if (
    value !== PROFILE_CODEQL &&
    value !== PROFILE_GITHUB_OPEN &&
    value !== PROFILE_PRIVILEGED_CALLER
  ) {
    throw new Error(
      "--profile must be codeql, github-open, or privileged-caller",
    );
  }
  return value;
}

/**
 * @param {string | undefined} value
 * @returns {string}
 */
function readWorkflowBasename(value) {
  if (value === undefined || !isWorkflowBasename(value)) {
    throw new Error(
      "--workflow requires a workflow basename ending in .yml or .yaml",
    );
  }
  return value;
}

/**
 * Keep one workflow file's count. A basename with no findings totals zero.
 * @param {{ total: number, byFile: Record<string, number> }} summary
 * @param {string | undefined} workflow
 * @returns {{ total: number, byFile: Record<string, number> }}
 */
export function selectWorkflowSummary(summary, workflow) {
  if (workflow === undefined) return summary;
  const count = Object.hasOwn(summary.byFile, workflow)
    ? summary.byFile[workflow]
    : 0;
  if (count === 0) return { total: 0, byFile: {} };
  return { total: count, byFile: { [workflow]: count } };
}

/**
 * @param {string[]} argv
 * @returns {{ profile: "codeql" | "github-open" | "privileged-caller", workflow: string | undefined }}
 */
export function parseCountArgs(argv) {
  /** @type {"codeql" | "github-open" | "privileged-caller"} */
  let profile = PROFILE_CODEQL;
  /** @type {string | undefined} */
  let workflow;
  let index = 0;
  while (index < argv.length) {
    const flag = argv[index];
    if (flag === "--profile") {
      profile = readProfile(argv[index + 1]);
      index += 2;
      continue;
    }
    if (flag === "--workflow") {
      workflow = readWorkflowBasename(argv[index + 1]);
      index += 2;
      continue;
    }
    throw new Error(`unknown argument ${flag}`);
  }
  return { profile, workflow };
}

/**
 * @param {string[]} argv
 * @returns {"codeql" | "github-open" | "privileged-caller"}
 */
export function parseCountProfile(argv) {
  return parseCountArgs(argv).profile;
}

/**
 * Stderr from an `execFileSync` failure, capped, or empty when the throw has none.
 * @param {unknown} error
 */
function readExecStderr(error) {
  if (!(error instanceof Error) || !Object.hasOwn(error, "stderr")) return "";
  const raw = error.stderr;
  const text = isString(raw)
    ? raw
    : Buffer.isBuffer(raw)
      ? raw.toString("utf8")
      : "";
  return text.length > EXEC_STDERR_LIMIT
    ? text.slice(0, EXEC_STDERR_LIMIT)
    : text;
}

const invoked =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const args = parseCountArgs(process.argv.slice(2));
    const summary =
      args.profile === PROFILE_GITHUB_OPEN
        ? countGithubOpenAlerts()
        : countPoisonableSteps({ profile: args.profile });
    const selected = selectWorkflowSummary(summary, args.workflow);
    process.stdout.write(`${JSON.stringify(selected)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stderr = readExecStderr(error);
    process.stderr.write(`${message}\n`);
    if (stderr.length > 0) process.stderr.write(stderr);
    process.exit(1);
  }
}
