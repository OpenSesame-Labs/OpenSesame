#!/usr/bin/env node
/**
 * Count CodeQL `actions/cache-poisoning/poisonable-step` findings.
 *
 * `--profile codeql` (the default when the flag is omitted) builds a minimal
 * Actions database from `.github/workflows` plus a minimal `package.json`,
 * then runs that query from the installed `codeql/actions-queries` pack.
 * `CODEQL_HOME` defaults to `/home/ubuntu/codeql-cli`.
 *
 * `--profile github-open` does not run CodeQL. It loads
 * `tools/security/codeql-poisonable-step-github-open.json` and sums every
 * workflow file in that open-alert baseline.
 *
 * `--workflow <basename.yml>` limits `total` and `byFile` to that one workflow
 * file. The value must be a basename ending in `.yml` (no directory). Both
 * profiles honor it. Omitted, every workflow file is counted.
 *
 * Prints one JSON object: `{ "total": number, "byFile": { "<basename>.yml": number } }`.
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
const GITHUB_OPEN_BASELINE =
  "tools/security/codeql-poisonable-step-github-open.json";
/** Workflow file name only: no directory, and the `.yml` suffix the flag takes. */
const WORKFLOW_BASENAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.yml$/u;

export function repoRootFromHere() {
  return fileURLToPath(new URL("../..", import.meta.url));
}

/** @param {unknown} sarif */
export function summarizeSarif(sarif) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  const runs = Array.isArray(sarif?.runs) ? sarif.runs : [];
  for (const run of runs) {
    const results = Array.isArray(run?.results) ? run.results : [];
    for (const result of results) {
      const uri = resultLocationUri(result);
      const file = basename(uri || "unknown");
      counts.set(file, (counts.get(file) ?? 0) + 1);
    }
  }
  const byFile = {};
  for (const file of [...counts.keys()].sort()) byFile[file] = counts.get(file);
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  return { total, byFile };
}

/** @param {unknown} result */
function resultLocationUri(result) {
  const locations = Array.isArray(result?.locations) ? result.locations : [];
  for (const location of locations) {
    const uri = readString(location?.physicalLocation?.artifactLocation?.uri);
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
 * A workflow argument is a file name, not a path. `ci.yml` passes;
 * `.github/workflows/ci.yml` does not.
 *
 * @param {string} value
 * @returns {string}
 */
export function validateWorkflowBasename(value) {
  if (value !== basename(value) || !WORKFLOW_BASENAME.test(value)) {
    throw new Error(`invalid workflow basename ${value}`);
  }
  return value;
}

/**
 * Keep one workflow file's count. A file with no findings counts as zero
 * and is omitted from `byFile`, matching the unfiltered summary.
 *
 * @param {{ total: number, byFile: Record<string, number> }} summary
 * @param {string | undefined} workflow
 * @returns {{ total: number, byFile: Record<string, number> }}
 */
export function limitSummaryToWorkflow(summary, workflow) {
  if (workflow === undefined) return summary;
  const selected = validateWorkflowBasename(workflow);
  const count = Object.hasOwn(summary.byFile, selected)
    ? summary.byFile[selected]
    : 0;
  if (count === 0) return { total: 0, byFile: {} };
  return { total: count, byFile: { [selected]: count } };
}

/**
 * @param {string | undefined} workflow
 * @returns {string | undefined}
 */
function optionalWorkflow(workflow) {
  if (workflow === undefined) return undefined;
  return validateWorkflowBasename(workflow);
}

/**
 * @param {{ repoRoot?: string, codeqlHome?: string, keepWork?: boolean, workflow?: string }} [options]
 * @returns {{ total: number, byFile: Record<string, number> }}
 */
export function countPoisonableSteps(options = {}) {
  const workflow = optionalWorkflow(options.workflow);
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
    mkdirSync(join(sourceRoot, ".github", "workflows"), { recursive: true });
    cpSync(
      join(repoRoot, ".github", "workflows"),
      join(sourceRoot, ".github", "workflows"),
      {
        recursive: true,
        filter: (source) => basename(source) !== ".git",
      },
    );
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
    return limitSummaryToWorkflow(
      summarizeSarif(JSON.parse(readFileSync(sarifPath, "utf8"))),
      workflow,
    );
  } finally {
    if (!options.keepWork) rmSync(work, { recursive: true, force: true });
  }
}

/** @param {unknown} value */
function readNonNegativeInteger(value) {
  if (Object(value) === value || !Number.isInteger(value) || value < 0) {
    return undefined;
  }
  return value;
}

/**
 * @param {unknown} entry
 * @param {number} index
 * @returns {{ workflow: string, openAlerts: number }}
 */
function readInventoryEntry(entry, index) {
  if (!isJsonObject(entry)) {
    throw new Error(
      `${GITHUB_OPEN_BASELINE} inventory[${index}] is not an object`,
    );
  }
  const workflow = readString(entry.workflow);
  const openAlerts = readNonNegativeInteger(entry.openAlerts);
  if (
    workflow === undefined ||
    workflow.length === 0 ||
    openAlerts === undefined
  ) {
    throw new Error(`${GITHUB_OPEN_BASELINE} inventory[${index}] is invalid`);
  }
  return { workflow, openAlerts };
}

/**
 * Sum the recorded GitHub open-alert baseline. Does not run CodeQL.
 *
 * @param {{ repoRoot?: string, workflow?: string }} [options]
 * @returns {{ total: number, byFile: Record<string, number> }}
 */
export function countGithubOpenAlerts(options = {}) {
  const workflow = optionalWorkflow(options.workflow);
  const repoRoot = options.repoRoot ?? repoRootFromHere();
  const parsed = JSON.parse(
    readFileSync(join(repoRoot, GITHUB_OPEN_BASELINE), "utf8"),
  );
  if (!isJsonObject(parsed) || !Array.isArray(parsed.inventory)) {
    throw new Error(`${GITHUB_OPEN_BASELINE} is missing an inventory array`);
  }
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (let index = 0; index < parsed.inventory.length; index += 1) {
    const counted = readInventoryEntry(parsed.inventory[index], index);
    counts.set(
      counted.workflow,
      (counts.get(counted.workflow) ?? 0) + counted.openAlerts,
    );
  }
  const byFile = {};
  for (const file of [...counts.keys()].sort()) byFile[file] = counts.get(file);
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  if (Object.hasOwn(parsed, "totalOpenAlerts")) {
    const recorded = readNonNegativeInteger(parsed.totalOpenAlerts);
    if (recorded === undefined) {
      throw new Error(
        `${GITHUB_OPEN_BASELINE} totalOpenAlerts is not a non-negative integer`,
      );
    }
    if (recorded !== total) {
      throw new Error(
        `${GITHUB_OPEN_BASELINE} totalOpenAlerts ${recorded} does not match the inventory sum ${total}`,
      );
    }
  }
  return limitSummaryToWorkflow({ total, byFile }, workflow);
}

/**
 * @param {readonly string[]} argv
 * @param {number} index
 * @returns {"codeql" | "github-open"}
 */
function readProfileValue(argv, index) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error("--profile requires codeql or github-open");
  }
  if (value !== PROFILE_CODEQL && value !== PROFILE_GITHUB_OPEN) {
    throw new Error(`unknown profile ${value}`);
  }
  return value;
}

/**
 * @param {readonly string[]} argv
 * @param {number} index
 * @param {string | undefined} current
 * @returns {string}
 */
function readWorkflowFlag(argv, index, current) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error("--workflow requires a workflow basename ending in .yml");
  }
  if (current !== undefined) {
    throw new Error("--workflow was provided more than once");
  }
  return validateWorkflowBasename(value);
}

/**
 * @param {readonly string[]} argv
 * @returns {{ profile: "codeql" | "github-open", workflow: string | undefined }}
 */
export function parseCountArgs(argv) {
  let profile = PROFILE_CODEQL;
  /** @type {string | undefined} */
  let workflow;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--profile") {
      profile = readProfileValue(argv, index);
      index += 1;
      continue;
    }
    if (arg === "--workflow") {
      workflow = readWorkflowFlag(argv, index, workflow);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument ${arg}`);
  }
  return { profile, workflow };
}

/**
 * @param {readonly string[]} argv
 * @returns {"codeql" | "github-open"}
 */
export function parseCountProfile(argv) {
  return parseCountArgs(argv).profile;
}

/**
 * @param {"codeql" | "github-open"} profile
 * @param {string | undefined} workflow
 */
function countForProfile(profile, workflow) {
  if (profile === PROFILE_GITHUB_OPEN) {
    return countGithubOpenAlerts({ workflow });
  }
  return countPoisonableSteps({ workflow });
}

/** Stderr from an `execFileSync` failure, or empty when the throw has none. */
function readExecStderr(error) {
  if (!(error instanceof Error) || !Object.hasOwn(error, "stderr")) return "";
  const { stderr } = error;
  if (isString(stderr)) return stderr;
  if (Buffer.isBuffer(stderr)) return stderr.toString("utf8");
  return "";
}

const invoked =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const parsed = parseCountArgs(process.argv.slice(2));
    const summary = countForProfile(parsed.profile, parsed.workflow);
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stderr = readExecStderr(error);
    process.stderr.write(`${message}\n`);
    if (stderr.length > 0) process.stderr.write(stderr);
    process.exit(1);
  }
}
