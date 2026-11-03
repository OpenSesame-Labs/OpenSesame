/**
 * Poll until the published npm version is visible.
 *
 * Same deadline as preview smoke: SMOKE_REGISTRY_DEADLINE_MS (default
 * 300000) and SMOKE_REGISTRY_POLL_MS (default 10000). CLI CD runs this in
 * the Preview publish job, immediately after publish, so the five-minute
 * clock starts before the smoke job is queued.
 *
 *   EXPECTED_VERSION=0.0.0-alpha.8 node scripts/release/cd-registry-wait.mjs
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CLI_PACKAGE,
  registryBudget,
  publishedPackageForWait,
  spawnCaptured,
  waitForPublishedVersion,
} from "./cd-preview-smoke.mjs";

async function main() {
  const { deadlineMs, pollMs } = registryBudget(process.env);
  const pkg = publishedPackageForWait(process.env);
  const seen = await waitForPublishedVersion(
    process.env.EXPECTED_VERSION,
    spawnCaptured,
    { deadlineMs, pollMs, pkg },
  );
  console.log(`registry visible ${pkg}@${seen}`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    const message =
      error instanceof Error ? error.message : "registry wait failed";
    console.error(message);
    process.exit(1);
  });
}
