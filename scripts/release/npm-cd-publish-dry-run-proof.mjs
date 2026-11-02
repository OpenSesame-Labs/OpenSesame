#!/usr/bin/env node
/**
 * Stage both CD npm packages and run npm publish --dry-run, logging version + dist-tag.
 */
import { spawnSync } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CD_PRODUCTION_DIST_TAG } from "./npm-prerelease-version.mjs";
import { NPM_PUBLISH } from "./npm-publish-names.mjs";
import { planNpmCdRelease } from "./plan-npm-cd-release.mjs";
import { stageCliRelease } from "./prepare-cli-release.mjs";
import { stagePagesRelease } from "./prepare-pages-release.mjs";

const sha = "916d491d83d1889bc2b6bc8b13c2eff09cf704fa";
const outLog =
  process.env.NPM_CD_DRY_RUN_LOG ??
  "/opt/cursor/artifacts/npm-cd-dry-run-proof.log";

async function ensureFile(path, contents) {
  try {
    await access(path);
  } catch {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
}

async function ensureCliDist() {
  await ensureFile(
    join(process.cwd(), "packages/cli/dist/bin.js"),
    "#!/usr/bin/env node\nconsole.log('stub');\n",
  );
}

async function ensurePagesDist() {
  await ensureFile(
    join(process.cwd(), "apps/pages/dist/index.html"),
    "<!doctype html><title>web-pwa</title>\n",
  );
}

function dryRun(releaseDir, distTag, label) {
  const result = spawnSync(
    "npm",
    ["publish", "--dry-run", "--access", "public", "--tag", distTag],
    { cwd: releaseDir, encoding: "utf8" },
  );
  const block = [
    `=== ${label} ===`,
    `directory=${releaseDir}`,
    `npm_dist_tag=${distTag}`,
    result.stdout,
    result.stderr,
  ].join("\n");
  if (result.status !== 0) {
    throw new Error(`${label} dry-run failed:\n${block}`);
  }
  return block;
}

async function main() {
  const cliPlan = planNpmCdRelease({
    npmPackageName: NPM_PUBLISH.cli.name,
    sha,
    tagPrefix: "cli-v",
    releaseName: "cli",
  });
  const webPlan = planNpmCdRelease({
    npmPackageName: NPM_PUBLISH.webPwa.name,
    sha,
    tagPrefix: "web-pwa-v",
    releaseName: "web-pwa",
  });
  for (const plan of [cliPlan, webPlan]) {
    if (plan.npmDistTag === "latest" || CD_PRODUCTION_DIST_TAG === "latest") {
      throw new Error("prerelease CD must not use dist-tag latest");
    }
  }
  await ensureCliDist();
  await ensurePagesDist();
  const cliRelease = await stageCliRelease(cliPlan.version);
  const webRelease = await stagePagesRelease(webPlan.version);
  const sections = [
    `cli_version=${cliPlan.version}`,
    `cli_npm_dist_tag=${cliPlan.npmDistTag}`,
    `cli_production_dist_tag=${CD_PRODUCTION_DIST_TAG}`,
    dryRun(cliRelease, cliPlan.npmDistTag, NPM_PUBLISH.cli.name),
    `web_pwa_version=${webPlan.version}`,
    `web_pwa_npm_dist_tag=${webPlan.npmDistTag}`,
    `web_pwa_production_dist_tag=${CD_PRODUCTION_DIST_TAG}`,
    dryRun(webRelease, webPlan.npmDistTag, NPM_PUBLISH.webPwa.name),
  ];
  const text = `${sections.join("\n\n")}\n`;
  await mkdir(dirname(outLog), { recursive: true });
  await writeFile(outLog, text);
  process.stdout.write(text);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
