#!/usr/bin/env node
/**
 * CD PWA Preview deploy smoke — Hurl HTTP checks with staged artifact digests.
 *
 *   node scripts/release/cd-pwa-preview-smoke/run.mjs
 *
 * Requires `hurl` on PATH (pinned in mise.toml). Writes a temp variables file,
 * runs registry.hurl then pages.hurl with bounded retries.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertNotProofGateFail } from "../cd-preview-smoke.mjs";
import { checkReleaseMeta } from "../cd-release-meta.mjs";
import { buildHurlVariables, serializeHurlVariables } from "./prepare-vars.mjs";
import { cdnRetryBudget, registryRetryBudget } from "./retry-budget.mjs";
import { captureLiveSmokeEvidence } from "./screenshot-evidence.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function runHurl(name, variablesPath, retry, intervalMs) {
  const hurlBin = process.env.HURL_BIN ?? "hurl";
  const args = [
    "--test",
    "--variables-file",
    variablesPath,
    "--retry",
    String(retry),
    "--retry-interval",
    `${intervalMs}ms`,
    join(here, name),
  ];
  const ran = spawnSync(hurlBin, args, {
    stdio: "inherit",
    env: process.env,
  });
  if (ran.error) {
    throw ran.error;
  }
  if (ran.status !== 0) {
    process.exit(ran.status === null ? 1 : ran.status);
  }
}

async function main() {
  const started = Date.now();
  assertNotProofGateFail(process.env);
  await checkReleaseMeta(
    resolve(process.env.STAGED_META ?? ""),
    resolve(process.env.STAGED_PACKAGE ?? ""),
    process.env,
  );
  const variables = buildHurlVariables(process.env);
  const varDir = mkdtempSync(join(tmpdir(), "cd-pwa-hurl-"));
  const varPath = join(varDir, "vars.properties");
  writeFileSync(varPath, serializeHurlVariables(variables));

  const registry = registryRetryBudget(process.env);
  const hurlStarted = Date.now();
  runHurl("registry.hurl", varPath, registry.attempts, registry.intervalMs);

  const cdn = cdnRetryBudget(process.env);
  runHurl("pages.hurl", varPath, cdn.attempts, cdn.intervalMs);
  const hurlMs = Date.now() - hurlStarted;

  const evidenceStarted = Date.now();
  const evidence = await captureLiveSmokeEvidence(process.env);
  const evidenceMs = Date.now() - evidenceStarted;

  const elapsedMs = Date.now() - started;
  console.log(
    `pwa preview smoke passed for @opensesame-labs/web-pwa@${variables.expected_version} at ${variables.pages_base} (total ${elapsedMs}ms: hurl ${hurlMs}ms, screenshots ${evidenceMs}ms, captured ${evidence.captured_ms}ms)`,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    const message =
      error instanceof Error ? error.message : "pwa preview smoke failed";
    console.error(message);
    process.exit(1);
  });
}
