#!/usr/bin/env node
/**
 * Compare headless browser stacks for CD screenshot legs.
 * Outputs JSON rows: install_bytes, install_ms, capture_ms, screenshots_ok, notes.
 *
 *   node scripts/ci/headless-browser-benchmark.mjs
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  benchAgentBrowser,
  benchLightpanda,
  benchStagehand,
} from "./headless-browser-benchmark-alternative-backends.mjs";
import {
  benchCftHeadlessShell,
  benchPlaywrightFullChromium,
  benchPlaywrightHeadlessShell,
  benchSystemChromium,
} from "./headless-browser-benchmark-playwright-backends.mjs";
import {
  repoRoot,
  resolveBenchDist,
} from "./headless-browser-benchmark-support.mjs";

/** Keys for `HEADLESS_BENCH_BACKENDS` (comma-separated). */
export const HEADLESS_BENCH_BACKEND_KEYS = [
  "system",
  "cft",
  "pw-hshell",
  "pw-full",
  "agent",
  "lightpanda",
  "stagehand",
];

const DEFAULT_HEADLESS_BENCH_BACKENDS = ["system", "cft", "pw-hshell"];

/** Select which backends to run; defaults to the CD-relevant trio only. */
export function selectHeadlessBenchBackends(raw) {
  const text = raw?.trim();
  if (text === undefined || text.length === 0) {
    return [...DEFAULT_HEADLESS_BENCH_BACKENDS];
  }
  const keys = text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const unknown = keys.filter(
    (key) => !HEADLESS_BENCH_BACKEND_KEYS.includes(key),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Unknown HEADLESS_BENCH_BACKENDS key(s): ${unknown.join(", ")}`,
    );
  }
  return keys;
}

function benchWallExceeded(startMs, limitSec) {
  if (limitSec === undefined) {
    return false;
  }
  return (Date.now() - startMs) / 1000 >= limitSec;
}

async function runSelectedBenchmarks(keys, wallStartMs, wallLimitSec) {
  const rows = [];
  const runners = {
    system: benchSystemChromium,
    cft: benchCftHeadlessShell,
    "pw-hshell": benchPlaywrightHeadlessShell,
    "pw-full": benchPlaywrightFullChromium,
    agent: benchAgentBrowser,
    lightpanda: benchLightpanda,
    stagehand: benchStagehand,
  };
  for (const key of keys) {
    if (benchWallExceeded(wallStartMs, wallLimitSec)) {
      rows.push({
        backend: `(skipped ${key})`,
        install_bytes: 0,
        install_ms: 0,
        capture_ms: 0,
        screenshots_ok: false,
        dom_assert_ok: false,
        notes: `HEADLESS_BENCH_WALL_SEC=${wallLimitSec} reached before ${key}`,
      });
      continue;
    }
    rows.push(await runners[key]());
  }
  return rows;
}

function readWallLimitSec() {
  const wallRaw = process.env.HEADLESS_BENCH_WALL_SEC?.trim();
  const wallLimitSec =
    wallRaw === undefined || wallRaw.length === 0 ? undefined : Number(wallRaw);
  if (
    wallLimitSec !== undefined &&
    (!Number.isFinite(wallLimitSec) || wallLimitSec <= 0)
  ) {
    throw new Error("HEADLESS_BENCH_WALL_SEC must be a positive number");
  }
  return wallLimitSec;
}

function printRowsTable(rows) {
  console.log(
    "\n| Backend | install_ms | install_MiB | capture_ms | dom_assert_ms | shots | dom | notes |",
  );
  console.log("| --- | ---: | ---: | ---: | ---: | --- | --- | --- |");
  for (const row of rows) {
    const mib = (row.install_bytes / (1024 * 1024)).toFixed(1);
    console.log(
      `| ${row.backend} | ${row.install_ms} | ${mib} | ${row.capture_ms} | ${row.dom_assert_ms ?? 0} | ${row.screenshots_ok ? "yes" : "no"} | ${row.dom_assert_ok ? "yes" : "no"} | ${row.notes.replace(/\|/g, "/")} |`,
    );
  }
}

async function main() {
  const wallLimitSec = readWallLimitSec();
  const keys = selectHeadlessBenchBackends(process.env.HEADLESS_BENCH_BACKENDS);
  const wallStartMs = Date.now();
  const rows = await runSelectedBenchmarks(keys, wallStartMs, wallLimitSec);

  const scored = rows.filter((r) => r.screenshots_ok);
  scored.sort(
    (a, b) => a.install_ms + a.capture_ms - (b.install_ms + b.capture_ms),
  );
  const winner = scored[0] ?? null;

  const report = {
    generated_at: new Date().toISOString(),
    github_run_id: process.env.GITHUB_RUN_ID ?? null,
    github_repository: process.env.GITHUB_REPOSITORY ?? null,
    dist: resolveBenchDist(),
    winner: winner?.backend ?? null,
    rows,
  };

  const outPath =
    process.env.HEADLESS_BENCH_OUT ??
    join(repoRoot, "artifacts/headless-browser-benchmark.json");
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  printRowsTable(rows);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
