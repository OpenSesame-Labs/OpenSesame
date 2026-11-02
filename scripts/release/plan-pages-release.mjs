#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CD_PREVIEW_DIST_TAG } from "./npm-prerelease-version.mjs";
import { NPM_PUBLISH } from "./npm-publish-names.mjs";
import { formatPlan } from "./plan-cli-release.mjs";
import { planNpmCdRelease } from "./plan-npm-cd-release.mjs";

function parseArgs(argv) {
  let sha = "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--sha") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--sha requires a value");
      }
      sha = value;
      index += 1;
    }
  }
  return { sha };
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const sha = parsed.sha !== "" ? parsed.sha : (process.env.GITHUB_SHA ?? "");
  const plan = planNpmCdRelease({
    npmPackageName: NPM_PUBLISH.webPwa.name,
    sha,
    tagPrefix: "web-pwa-v",
    releaseName: "web-pwa",
    preid: process.env.NPM_PRERELEASE_ID ?? CD_PREVIEW_DIST_TAG,
  });
  process.stdout.write(`${formatPlan(plan)}\n`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : "plan failed";
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}
