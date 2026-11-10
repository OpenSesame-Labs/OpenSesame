/**
 * Committed shrinkwrap for the CLI container image must match prepare-cli-release
 * dependency pins. The image runs npm ci --omit=dev --ignore-scripts against
 * npm-shrinkwrap.json copied beside the staged publish package.json.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NPM_PUBLISH } from "./npm-publish-names.mjs";
import { buildCliPublishManifest } from "./prepare-cli-release.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const CLI_SHRINKWRAP_PATH = join(
  root,
  "ops/containers/cli/npm-shrinkwrap.json",
);

export function shrinkwrapRootDependencies(shrinkwrap) {
  const rootPkg = shrinkwrap.packages?.[""];
  if (!rootPkg?.dependencies) {
    throw new Error("shrinkwrap root package missing dependencies");
  }
  return rootPkg.dependencies;
}

export function expectedShrinkwrapDependencies() {
  const manifest = JSON.parse(
    readFileSync(join(root, "packages/cli/package.json"), "utf8"),
  );
  return buildCliPublishManifest(manifest, "0.0.0-shrinkwrap-check")
    .dependencies;
}

export function assertCliShrinkwrapMatchesWorkspace(
  shrinkwrapPath = CLI_SHRINKWRAP_PATH,
) {
  const shrinkwrap = JSON.parse(readFileSync(shrinkwrapPath, "utf8"));
  const actual = shrinkwrapRootDependencies(shrinkwrap);
  const expected = expectedShrinkwrapDependencies();
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const name of keys) {
    if (expected[name] !== actual[name]) {
      throw new Error(
        `CLI shrinkwrap drift at packages[].dependencies[${JSON.stringify(name)}]: ` +
          `expected ${JSON.stringify(expected[name])}, got ${JSON.stringify(actual[name])}. ` +
          `Run: node scripts/release/cli-shrinkwrap.mjs write`,
      );
    }
  }
}

export async function writeCliShrinkwrap(shrinkwrapPath = CLI_SHRINKWRAP_PATH) {
  const manifest = JSON.parse(
    await readFile(join(root, "packages/cli/package.json"), "utf8"),
  );
  const publishManifest = buildCliPublishManifest(
    manifest,
    "0.0.0-shrinkwrap-gen",
  );
  const tmp = await mkdtemp(join(tmpdir(), "cli-shrinkwrap-"));
  try {
    await writeFile(
      join(tmp, "package.json"),
      `${JSON.stringify(
        {
          ...publishManifest,
          name: NPM_PUBLISH.cli.name,
          bin: publishManifest.bin,
        },
        null,
        2,
      )}\n`,
    );
    execFileSync(
      "npm",
      ["install", "--package-lock-only", "--omit=dev", "--ignore-scripts"],
      {
        cwd: tmp,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          npm_config_ignore_scripts: "true",
        },
      },
    );
    const lock = JSON.parse(
      await readFile(join(tmp, "package-lock.json"), "utf8"),
    );
    lock.name = NPM_PUBLISH.cli.name;
    lock.version = "0.0.0-local";
    if (lock.packages?.[""]) {
      lock.packages[""].name = NPM_PUBLISH.cli.name;
      lock.packages[""].version = "0.0.0-local";
    }
    await writeFile(shrinkwrapPath, `${JSON.stringify(lock, null, 2)}\n`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function main() {
  const command = process.argv[2] ?? "check";
  if (command === "check") {
    assertCliShrinkwrapMatchesWorkspace();
    process.stdout.write("CLI shrinkwrap matches packages/cli publish deps\n");
    return;
  }
  if (command === "write") {
    await writeCliShrinkwrap();
    assertCliShrinkwrapMatchesWorkspace();
    process.stdout.write(`Wrote ${CLI_SHRINKWRAP_PATH}\n`);
    return;
  }
  throw new Error(
    "Usage: cli-shrinkwrap.mjs check|write\n  check — fail when ops/containers/cli/npm-shrinkwrap.json drifts\n  write — regenerate from packages/cli (registry fetch)",
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
