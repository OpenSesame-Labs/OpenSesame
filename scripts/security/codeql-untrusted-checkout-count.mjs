#!/usr/bin/env node
/**
 * Count CodeQL `actions/untrusted-checkout/*` findings.
 *
 * Builds a minimal Actions database from `.github/workflows` plus a minimal
 * `package.json`, then runs every query whose `@id` is
 * `actions/untrusted-checkout/<severity>`. `CODEQL_HOME` defaults to
 * `/home/ubuntu/codeql-cli`.
 *
 * `--workflow <basename.yml>` limits `total` and `byFile` to one workflow
 * basename. Prints `{ "total": number, "byFile": { "<basename>.yml": number } }`.
 */
import { execFileSync } from "node:child_process";
import {
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
import {
  isWorkflowBasename,
  repoRootFromHere,
  selectWorkflowSummary,
  stageWorkflows,
} from "./codeql-actions-poisonable-count.mjs";

const QUERY_ID_PREFIX = "actions/untrusted-checkout/";
const DEFAULT_CODEQL_HOME = "/home/ubuntu/codeql-cli";
const EXEC_STDERR_LIMIT = 1024 * 1024;

/**
 * @param {string} codeqlHome
 * @returns {string[]}
 */
export function untrustedCheckoutQueryPaths(codeqlHome) {
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
      const id = text.match(/@id\s+(\S+)/u);
      if (id?.[1]?.startsWith(QUERY_ID_PREFIX)) found.push(path);
    }
  };
  visit(packRoot);
  if (found.length === 0) {
    throw new Error(
      `queries ${QUERY_ID_PREFIX}* not found under ${packRoot} (CODEQL_HOME=${codeqlHome})`,
    );
  }
  found.sort();
  return found;
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

/** @param {unknown} result */
function resultRuleId(result) {
  if (!isJsonObject(result)) return "";
  const direct = readString(result.ruleId);
  if (direct !== undefined && direct.length > 0) return direct;
  const rule = result.rule;
  if (!isJsonObject(rule)) return "";
  return readString(rule.id) ?? "";
}

/**
 * Count `actions/untrusted-checkout/<severity>` results by workflow basename.
 * @param {unknown} sarif
 * @returns {{ total: number, byFile: Record<string, number>, byRule: Record<string, number> }}
 */
export function summarizeUntrustedCheckoutSarif(sarif) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  /** @type {Map<string, number>} */
  const rules = new Map();
  const runs =
    isJsonObject(sarif) && Array.isArray(sarif.runs) ? sarif.runs : [];
  for (const run of runs) {
    const results =
      isJsonObject(run) && Array.isArray(run.results) ? run.results : [];
    for (const result of results) {
      const ruleId = resultRuleId(result);
      if (!ruleId.startsWith(QUERY_ID_PREFIX)) continue;
      const uri = resultLocationUri(result);
      const file = basename(uri || "unknown");
      counts.set(file, (counts.get(file) ?? 0) + 1);
      rules.set(ruleId, (rules.get(ruleId) ?? 0) + 1);
    }
  }
  /** @type {Record<string, number>} */
  const byFile = {};
  for (const file of [...counts.keys()].sort()) byFile[file] = counts.get(file);
  /** @type {Record<string, number>} */
  const byRule = {};
  for (const rule of [...rules.keys()].sort()) byRule[rule] = rules.get(rule);
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  return { total, byFile, byRule };
}

/**
 * @param {{ repoRoot?: string, codeqlHome?: string, keepWork?: boolean }} [options]
 * @returns {{ total: number, byFile: Record<string, number>, byRule: Record<string, number> }}
 */
export function countUntrustedCheckouts(options = {}) {
  const repoRoot = options.repoRoot ?? repoRootFromHere();
  const codeqlHome =
    options.codeqlHome ?? process.env.CODEQL_HOME ?? DEFAULT_CODEQL_HOME;
  const codeql = join(codeqlHome, "codeql");
  const queries = untrustedCheckoutQueryPaths(codeqlHome);
  const work = mkdtempSync(join(tmpdir(), "codeql-untrusted-checkout-"));
  const sourceRoot = join(work, "src");
  const database = join(work, "db");
  const sarifPath = join(work, "untrusted-checkout.sarif");
  try {
    stageWorkflows(repoRoot, sourceRoot, "codeql");
    writeFileSync(
      join(sourceRoot, "package.json"),
      `${JSON.stringify({ name: "codeql-actions-db", private: true })}\n`,
    );
    mkdirSync(database, { recursive: true });
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
        ...queries,
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    return summarizeUntrustedCheckoutSarif(
      JSON.parse(readFileSync(sarifPath, "utf8")),
    );
  } finally {
    if (!options.keepWork) rmSync(work, { recursive: true, force: true });
  }
}

/**
 * @param {string[]} argv
 * @returns {{ workflow: string | undefined }}
 */
export function parseUntrustedCheckoutArgs(argv) {
  /** @type {string | undefined} */
  let workflow;
  let index = 0;
  while (index < argv.length) {
    const flag = argv[index];
    if (flag === "--workflow") {
      const value = argv[index + 1];
      if (value === undefined || !isWorkflowBasename(value)) {
        throw new Error(
          "--workflow requires a workflow basename ending in .yml or .yaml",
        );
      }
      workflow = value;
      index += 2;
      continue;
    }
    throw new Error(`unknown argument ${flag}`);
  }
  return { workflow };
}

/**
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
    const args = parseUntrustedCheckoutArgs(process.argv.slice(2));
    const summary = countUntrustedCheckouts();
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
