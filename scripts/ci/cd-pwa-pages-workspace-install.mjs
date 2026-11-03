#!/usr/bin/env node
/**
 * Frozen install for CD PWA jobs that only need the Pages workspace graph.
 * Trunk CI already ran TypeScript, Rust, and Bundle budgets on the same commit.
 *
 * Root scripts (install-profile proof gate) import `sharp`, which lives in the
 * repo root devDependencies and is not linked by a Pages-only workspace ci.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isJsonObject, readString } from "../lib/json-boundary.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export function pinnedSharpVersion() {
  const raw = readFileSync(join(repoRoot, "package.json"), "utf8");
  const parsed = JSON.parse(raw);
  if (!isJsonObject(parsed)) {
    throw new Error("root package.json is invalid");
  }
  let version = undefined;
  if (isJsonObject(parsed.devDependencies)) {
    version = readString(parsed.devDependencies.sharp);
  }
  if (version === undefined && isJsonObject(parsed.overrides)) {
    version = readString(parsed.overrides.sharp);
  }
  if (version === undefined || version.length === 0) {
    throw new Error(
      "root package.json must pin sharp in devDependencies or overrides",
    );
  }
  return version;
}

function runNpm(args) {
  const ran = spawnSync("npm", args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (ran.error) {
    console.error(ran.error.message);
    process.exit(1);
  }
  if (ran.status !== 0) {
    process.exit(ran.status ?? 1);
  }
}

function main() {
  runNpm(["ci", "--include-workspace-root", "-w", "@opensesame/pages"]);
  const sharpVersion = pinnedSharpVersion();
  runNpm([
    "install",
    "--no-save",
    "--prefer-offline",
    "--no-audit",
    "--no-fund",
    `sharp@${sharpVersion}`,
  ]);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main();
}
