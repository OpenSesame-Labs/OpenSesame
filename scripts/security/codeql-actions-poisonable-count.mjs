#!/usr/bin/env node
/**
 * Count CodeQL `actions/cache-poisoning/poisonable-step` findings.
 *
 * `--profile codeql` (the default) builds a minimal Actions database from
 * `.github/workflows` plus a minimal `package.json`, then runs that query
 * from the installed `codeql/actions-queries` pack. `CODEQL_HOME` defaults
 * to `/home/ubuntu/codeql-cli`.
 *
 * `--profile github-open` does not run CodeQL. It loads
 * `tools/security/codeql-poisonable-step-github-open.json` and sums every
 * workflow file in that open-alert baseline.
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
const GITHUB_OPEN_BASELINE = join(
  "tools",
  "security",
  "codeql-poisonable-step-github-open.json",
);
/** Failure logs from CodeQL are diagnostic, not a payload to retain in full. */
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
 * @param {{ repoRoot?: string, codeqlHome?: string, keepWork?: boolean }} [options]
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

/**
 * `--profile codeql` is the default. `--profile github-open` reads the baseline.
 * @param {string[]} argv
 * @returns {"codeql" | "github-open"}
 */
export function parseCountProfile(argv) {
  let profile = PROFILE_CODEQL;
  let index = 0;
  while (index < argv.length) {
    const flag = argv[index];
    if (flag !== "--profile") throw new Error(`unknown argument ${flag}`);
    const value = argv[index + 1];
    if (value !== PROFILE_CODEQL && value !== PROFILE_GITHUB_OPEN) {
      throw new Error("--profile must be codeql or github-open");
    }
    profile = value;
    index += 2;
  }
  return profile;
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
    const profile = parseCountProfile(process.argv.slice(2));
    const summary =
      profile === PROFILE_GITHUB_OPEN
        ? countGithubOpenAlerts()
        : countPoisonableSteps();
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stderr = readExecStderr(error);
    process.stderr.write(`${message}\n`);
    if (stderr.length > 0) process.stderr.write(stderr);
    process.exit(1);
  }
}
