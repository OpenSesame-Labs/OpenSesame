#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { formatPlan, planCliRelease } from "./plan-cli-release.mjs";

const root = resolve(import.meta.dirname, "../..");
const manifestPath = resolve(root, "apps/pages/package.json");

function parseArgs(argv) {
  let mode = "";
  let sha = "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--mode" || arg === "--sha") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      if (arg === "--mode") mode = value;
      else sha = value;
      index += 1;
    }
  }
  if (!mode) throw new Error("--mode is required");
  return { mode, sha };
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const sha = parsed.sha !== "" ? parsed.sha : (process.env.GITHUB_SHA ?? "");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const plan = planCliRelease({
    mode: parsed.mode,
    packageVersion: manifest.version,
    sha,
    stamp: process.env.RELEASE_STAMP,
    tagPrefix: "pages-pwa-v",
    releaseName: "pages-pwa",
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
