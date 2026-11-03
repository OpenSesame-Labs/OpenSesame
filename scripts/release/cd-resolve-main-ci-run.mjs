#!/usr/bin/env node
/**
 * Emit the admitted main CI workflow run id for GITHUB_OUTPUT (CD artifact download).
 *
 *   GH_TOKEN=... GITHUB_REPOSITORY=owner/name GITHUB_SHA=<40 hex> \
 *     node scripts/release/cd-resolve-main-ci-run.mjs
 */
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  readGateConfig,
  resolveAdmittedMainCiRun,
} from "./cd-main-ci-gate.mjs";

export async function writeMainCiRunId(env, fetcher) {
  const config = readGateConfig(env);
  const admitted = await resolveAdmittedMainCiRun(config, fetcher);
  const outputPath = env.GITHUB_OUTPUT;
  if (outputPath !== undefined && outputPath.length > 0) {
    appendFileSync(outputPath, `run_id=${admitted.runId}\n`, "utf8");
  }
  return admitted.runId;
}

async function main() {
  const runId = await writeMainCiRunId(process.env, fetch);
  console.log(`main_ci_run_id=${runId}`);
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
