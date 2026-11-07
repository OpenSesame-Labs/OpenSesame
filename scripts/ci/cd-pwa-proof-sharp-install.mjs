#!/usr/bin/env node
/**
 * Link pinned `sharp` for CD install-profile proof after Pages workspace ci.
 * Isolated from build_full_profile dist compile (no sharp needed there).
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

export function installPinnedSharpForProof() {
  const sharpVersion = pinnedSharpVersion();
  const ran = spawnSync(
    "npm",
    [
      "install",
      "--no-save",
      "--prefer-offline",
      "--no-audit",
      "--no-fund",
      "--legacy-peer-deps",
      `sharp@${sharpVersion}`,
    ],
    { cwd: repoRoot, stdio: "inherit", env: process.env },
  );
  if (ran.error) {
    throw ran.error;
  }
  if (ran.status !== 0) {
    process.exit(ran.status ?? 1);
  }
}

function main() {
  installPinnedSharpForProof();
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main();
}
