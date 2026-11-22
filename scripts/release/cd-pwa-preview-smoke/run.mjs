#!/usr/bin/env node
/**
 * CD PWA Preview deploy smoke — Hurl HTTP checks with staged artifact digests.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertNotProofGateFail } from "../cd-preview-smoke.mjs";
import { checkReleaseMeta } from "../cd-release-meta.mjs";
import { pollLiveShellAssets } from "./live-bundle-poll.mjs";
import { buildHurlVariables, serializeHurlVariables } from "./prepare-vars.mjs";
import { cdnRetryBudget, hurlMaxTimeArg } from "./retry-budget.mjs";
import { captureLiveSmokeEvidence } from "./screenshot-evidence.mjs";
import {
  bootstrapSmokeEvidence,
  redactDiagnosticText,
  writeSmokePhaseFailure,
} from "./smoke-failure-evidence.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function runHurl(name, variablesPath, retry, intervalMs, maxTimeArg) {
  const hurlBin = process.env.HURL_BIN ?? "hurl";
  const args = [
    "--test",
    "--variables-file",
    variablesPath,
    "--max-time",
    maxTimeArg,
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
    throw new Error(`hurl ${name} failed with exit ${ran.status ?? 1}`);
  }
}

/**
 * Write one phase's failure evidence without ever replacing the original
 * error: mark `phaseWritten` only after the write lands so the outer `run`
 * phase cannot overwrite a capture, hurl, or shell-poll record.
 */
async function recordPhaseFailure(phase, error) {
  try {
    await writeSmokePhaseFailure(process.env, phase, error);
    if (error instanceof Error) error.phaseWritten = true;
  } catch (evidenceError) {
    console.error(
      redactDiagnosticText(
        evidenceError instanceof Error
          ? evidenceError.message
          : "failure evidence was not written",
      ),
    );
  }
}

async function main() {
  const started = Date.now();
  assertNotProofGateFail(process.env);
  await bootstrapSmokeEvidence(process.env);
  await checkReleaseMeta(
    resolve(process.env.STAGED_META ?? ""),
    resolve(process.env.STAGED_PACKAGE ?? ""),
    process.env,
  );
  const variables = buildHurlVariables(process.env);
  const varDir = mkdtempSync(join(tmpdir(), "cd-pwa-hurl-"));
  const varPath = join(varDir, "vars.properties");
  writeFileSync(varPath, serializeHurlVariables(variables));

  const cdnStartedMs = Date.now();
  process.env.PWA_SMOKE_CDN_STARTED_MS = String(cdnStartedMs);
  const cdn = cdnRetryBudget(process.env);
  const hurlStarted = Date.now();
  try {
    runHurl(
      "pages.hurl",
      varPath,
      cdn.retries,
      cdn.intervalMs,
      hurlMaxTimeArg(cdn.maxTimeMs),
    );
  } catch (error) {
    await recordPhaseFailure("hurl", error);
    throw error;
  }
  const hurlMs = Date.now() - hurlStarted;

  const shellStarted = Date.now();
  let shellAssets;
  try {
    shellAssets = await pollLiveShellAssets(process.env);
  } catch (error) {
    await recordPhaseFailure("shell-poll", error);
    throw error;
  }
  const shellMs = Date.now() - shellStarted;

  const evidenceStarted = Date.now();
  let evidence;
  try {
    evidence = await captureLiveSmokeEvidence(process.env);
  } catch (error) {
    if (error?.phaseWritten !== true) {
      await recordPhaseFailure("capture", error);
    }
    throw error;
  }
  const evidenceMs = Date.now() - evidenceStarted;

  const elapsedMs = Date.now() - started;
  console.log(
    `pwa preview smoke passed at ${variables.pages_base} (total ${elapsedMs}ms: hurl ${hurlMs}ms, shell ${shellAssets.length} assets ${shellMs}ms, screenshots ${evidenceMs}ms, captured ${evidence.captured_ms}ms)`,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch(async (error) => {
    const message =
      error instanceof Error ? error.message : "pwa preview smoke failed";
    console.error(redactDiagnosticText(message));
    if (!(error instanceof Error && error.phaseWritten === true)) {
      await recordPhaseFailure("run", error);
    }
    process.exit(1);
  });
}
