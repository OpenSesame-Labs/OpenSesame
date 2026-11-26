#!/usr/bin/env node
/**
 * Frozen install for CD PWA jobs that only need the Pages workspace graph.
 * Trunk CI already ran TypeScript, Rust, and Bundle budgets on the same commit.
 */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** Derive a single-package lock from the repository lock; never trust an unlocked version. */
export function smokeInstallLock(pkg, lock) {
  const expected = pkg?.devDependencies?.["playwright-core"];
  const original = lock?.packages?.["node_modules/playwright-core"];
  if (
    lock?.lockfileVersion !== 3 ||
    typeof expected !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(expected) ||
    original?.version !== expected ||
    original?.resolved !==
      `https://registry.npmjs.org/playwright-core/-/playwright-core-${expected}.tgz` ||
    typeof original?.integrity !== "string" ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/.test(original.integrity) ||
    Buffer.from(original.integrity.slice(7), "base64").length !== 64 ||
    [
      "dependencies",
      "optionalDependencies",
      "peerDependencies",
      "bundleDependencies",
    ].some((key) => original[key] && Object.keys(original[key]).length > 0)
  )
    throw new Error(
      "The locked playwright-core dependency is not a valid standalone package",
    );
  const packageJson = {
    name: "opensesame-cd-pwa-smoke-deps",
    version: "0.0.0",
    private: true,
    dependencies: { "playwright-core": expected },
  };
  const entry = { ...original };
  delete entry.dev;
  delete entry.devOptional;
  delete entry.optional;
  const packageLock = {
    name: packageJson.name,
    version: packageJson.version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: packageJson.name,
        version: packageJson.version,
        dependencies: packageJson.dependencies,
      },
      "node_modules/playwright-core": entry,
    },
  };
  return { packageJson, packageLock };
}

function installSmokeDependencies() {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const lock = JSON.parse(
    readFileSync(join(repoRoot, "package-lock.json"), "utf8"),
  );
  const plan = smokeInstallLock(pkg, lock);
  const prefix = mkdtempSync(join(tmpdir(), "opensesame-pwa-smoke-deps-"));
  writeFileSync(
    join(prefix, "package.json"),
    `${JSON.stringify(plan.packageJson, null, 2)}\n`,
  );
  writeFileSync(
    join(prefix, "package-lock.json"),
    `${JSON.stringify(plan.packageLock, null, 2)}\n`,
  );
  const ran = spawnSync("npm", ["ci", "--ignore-scripts", "--prefix", prefix], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (ran.error) throw ran.error;
  if (ran.status !== 0) process.exit(ran.status ?? 1);
  mkdirSync(join(repoRoot, "node_modules"), { recursive: true });
  symlinkSync(
    join(prefix, "node_modules/playwright-core"),
    join(repoRoot, "node_modules/playwright-core"),
    "dir",
  );
}

function main() {
  if (process.argv[2] === "--preview-smoke") return installSmokeDependencies();
  if (process.argv.length !== 2) throw new Error("Unknown install mode");
  const ran = spawnSync(
    "npm",
    [
      "ci",
      "--ignore-scripts",
      "--include-workspace-root",
      "-w",
      "@opensesame/pages",
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
      env: process.env,
    },
  );
  if (ran.error) {
    console.error(ran.error.message);
    process.exit(1);
  }
  process.exit(ran.status ?? 1);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main();
}
