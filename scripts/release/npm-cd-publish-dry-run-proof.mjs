#!/usr/bin/env node
import { spawnSync } from "node:child_process";
/**
 * Stage both CD npm packages and run npm publish --dry-run.
 * Alpha uses the planned dist-tag. Production rewrites 0.0.0-alpha.N to
 * 0.0.0-next.N and dry-runs --tag next on the same payload bytes.
 */
import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import {
  alphaVersionToNextProduction,
  rewritePackageVersionFile,
} from "./cd-production-npm-version.mjs";
import { CD_PRODUCTION_DIST_TAG } from "./npm-prerelease-version.mjs";
import { NPM_PUBLISH } from "./npm-publish-names.mjs";
import { planNpmCdRelease } from "./plan-npm-cd-release.mjs";
import { stageCliRelease } from "./prepare-cli-release.mjs";
import { stagePagesRelease } from "./prepare-pages-release.mjs";

const sha = "916d491d83d1889bc2b6bc8b13c2eff09cf704fa";
const outLog =
  process.env.NPM_CD_DRY_RUN_LOG ??
  "/opt/cursor/artifacts/npm-cd-dry-run-proof.log";
const productionLog =
  process.env.NPM_CD_PRODUCTION_DRY_RUN_LOG ??
  "/opt/cursor/artifacts/npm-cd-production-dry-run-proof.log";

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

function dryRun(releaseDir, distTag, label, expectVersion) {
  const result = spawnSync(
    "npm",
    ["publish", "--dry-run", "--access", "public", "--tag", distTag],
    { cwd: releaseDir, encoding: "utf8" },
  );
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const block = [
    `=== ${label} ===`,
    `directory=${releaseDir}`,
    `npm_dist_tag=${distTag}`,
    output,
  ].join("\n");
  if (result.status !== 0) {
    throw new Error(`${label} dry-run failed:\n${block}`);
  }
  if (expectVersion !== undefined && !output.includes(expectVersion)) {
    throw new Error(
      `${label} dry-run did not mention ${expectVersion}:\n${block}`,
    );
  }
  return block;
}

async function payloadDigest(dir) {
  const hash = createHash("sha256");
  const files = [];
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() && path !== join(dir, "package.json")) {
        files.push(path);
      }
    }
  }
  await walk(dir);
  for (const path of files) {
    hash.update(relative(dir, path));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
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
    dryRun(
      cliRelease,
      cliPlan.npmDistTag,
      NPM_PUBLISH.cli.name,
      cliPlan.version,
    ),
    `web_pwa_version=${webPlan.version}`,
    `web_pwa_npm_dist_tag=${webPlan.npmDistTag}`,
    `web_pwa_production_dist_tag=${CD_PRODUCTION_DIST_TAG}`,
    dryRun(
      webRelease,
      webPlan.npmDistTag,
      NPM_PUBLISH.webPwa.name,
      webPlan.version,
    ),
  ];
  const text = `${sections.join("\n\n")}\n`;
  await mkdir(dirname(outLog), { recursive: true });
  await writeFile(outLog, text);

  const cliDigest = await payloadDigest(cliRelease);
  const webDigest = await payloadDigest(webRelease);
  const cliNext = await rewritePackageVersionFile(
    join(cliRelease, "package.json"),
  );
  const webNext = await rewritePackageVersionFile(
    join(webRelease, "package.json"),
  );
  if (cliNext !== alphaVersionToNextProduction(cliPlan.version)) {
    throw new Error(`cli rewrite ${cliNext} does not match the alpha plan`);
  }
  if (webNext !== alphaVersionToNextProduction(webPlan.version)) {
    throw new Error(`web-pwa rewrite ${webNext} does not match the alpha plan`);
  }
  if ((await payloadDigest(cliRelease)) !== cliDigest) {
    throw new Error("cli payload bytes changed during the version rewrite");
  }
  if ((await payloadDigest(webRelease)) !== webDigest) {
    throw new Error("web-pwa payload bytes changed during the version rewrite");
  }
  const productionSections = [
    `cli_alpha_version=${cliPlan.version}`,
    `cli_production_version=${cliNext}`,
    `cli_production_dist_tag=${CD_PRODUCTION_DIST_TAG}`,
    `cli_payload_sha256=${cliDigest}`,
    dryRun(
      cliRelease,
      CD_PRODUCTION_DIST_TAG,
      `${NPM_PUBLISH.cli.name} production`,
      cliNext,
    ),
    `web_pwa_alpha_version=${webPlan.version}`,
    `web_pwa_production_version=${webNext}`,
    `web_pwa_production_dist_tag=${CD_PRODUCTION_DIST_TAG}`,
    `web_pwa_payload_sha256=${webDigest}`,
    dryRun(
      webRelease,
      CD_PRODUCTION_DIST_TAG,
      `${NPM_PUBLISH.webPwa.name} production`,
      webNext,
    ),
  ];
  const productionText = `${productionSections.join("\n\n")}\n`;
  await mkdir(dirname(productionLog), { recursive: true });
  await writeFile(productionLog, productionText);
  process.stdout.write(text);
  process.stdout.write(productionText);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
