// Compare the repo's TypeScript 7 `tsc` with `@typescript/native-preview`'s
// `tsgo` on every workspace `typecheck` script that is a single tsc invocation.
// Adoption requires the same exit code, stdout, and stderr. This script does
// not change the typecheck task.
//
// 2026-11-02 local script sum, this tree: `tsc` is already the native
// TypeScript 7.0.2 binary. `@typescript/native-preview` 7.0.0-dev.20260707.2
// (`tsgo`) matched exit code, stdout, and stderr on all 67 single-invocation
// packages (baseline 31161 ms, candidate 28987 ms). Those figures are the
// script's summed per-package timings, not a GitHub Actions job wall time.
// The three browser-extension scripts
// (`wxt prepare && tsc --noEmit -p .wxt/tsconfig.json`) were compared on the
// tsc step only and also matched. The preview is an older dev build of the
// compiler `turbo run typecheck` already runs, so the task is unchanged.
//
// CI wall time is from `gh run view` on the pull request checks. Neither run
// selected TypeScript packages, so "Build affected TypeScript graph" was
// skipped and the TypeScript job only reported that result.
// Before, run 41559786830 on PR #2412: TypeScript 9s, Rust 7s, Bundle budgets
// 10s, Affected build graph 14s.
// After, run 41559897362 on PR #2409: TypeScript 8s, Rust 8s, Bundle budgets
// 9s, Affected build graph 12s.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const tsc = join(root, "node_modules/typescript/bin/tsc");
const tsgo = process.env.TSGO_BIN ?? "/tmp/tsgo-bench/node_modules/.bin/tsgo";

function walk(dir, found) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === "node_modules" ||
      entry.name === ".git" ||
      entry.name === "target" ||
      entry.name === "dist" ||
      entry.name === "work" ||
      entry.name === ".turbo"
    ) {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, found);
    else if (
      entry.name === "package.json" &&
      path !== join(root, "package.json")
    ) {
      found.push(path);
    }
  }
  return found;
}

function tscArgs(script) {
  const match = /^tsc(?:\s+(.*))?$/.exec(script.trim());
  if (!match) return undefined;
  const args = match[1] ? match[1].split(/\s+/).filter(Boolean) : [];
  return args;
}

function run(bin, cwd, args) {
  const started = performance.now();
  const result = spawnSync(bin, args, { cwd, encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message ?? "",
    ms: Math.round(performance.now() - started),
  };
}

function same(left, right) {
  return (
    left.status === right.status &&
    left.stdout === right.stdout &&
    left.stderr === right.stderr
  );
}

const packages = walk(root, []);
const rows = [];
for (const file of packages) {
  const dir = join(file, "..");
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  const script = manifest.scripts?.typecheck;
  if (!script) continue;
  const args = tscArgs(script);
  const name = manifest.name ?? relative(root, dir);
  if (!args) {
    rows.push({ name, script, skipped: true });
    continue;
  }
  const baseline = run(tsc, dir, args);
  const candidate = run(tsgo, dir, args);
  rows.push({
    name,
    script,
    skipped: false,
    identical: same(baseline, candidate),
    baseline,
    candidate,
  });
  const mark = same(baseline, candidate) ? "same" : "DIFF";
  console.log(
    `${mark}\t${name}\tbaseline ${baseline.status} ${baseline.ms}ms\tcandidate ${candidate.status} ${candidate.ms}ms`,
  );
}

const compared = rows.filter((row) => !row.skipped);
const identical = compared.every((row) => row.identical);
const baselineMs = compared.reduce((sum, row) => sum + row.baseline.ms, 0);
const candidateMs = compared.reduce((sum, row) => sum + row.candidate.ms, 0);
const summary = {
  tsc,
  tsgo,
  compared: compared.length,
  skipped: rows.filter((row) => row.skipped).map((row) => row.name),
  identical,
  baselineMs,
  candidateMs,
  diffs: compared
    .filter((row) => !row.identical)
    .map((row) => ({
      name: row.name,
      baselineStatus: row.baseline.status,
      candidateStatus: row.candidate.status,
      stdoutSame: row.baseline.stdout === row.candidate.stdout,
      stderrSame: row.baseline.stderr === row.candidate.stderr,
      baselineStderr: row.baseline.stderr.slice(0, 500),
      candidateStderr: row.candidate.stderr.slice(0, 500),
      baselineStdout: row.baseline.stdout.slice(0, 500),
      candidateStdout: row.candidate.stdout.slice(0, 500),
    })),
};
console.log(
  JSON.stringify({
    identical: summary.identical,
    compared: summary.compared,
    skipped: summary.skipped,
    baselineMs: summary.baselineMs,
    candidateMs: summary.candidateMs,
    diffCount: summary.diffs.length,
  }),
);
const outDir = join(root, "work");
if (!existsSync(outDir)) mkdirSync(outDir);
writeFileSync(
  join(outDir, "tsgo-benchmark.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
if (!existsSync(tsc) || !existsSync(tsgo)) process.exitCode = 2;
