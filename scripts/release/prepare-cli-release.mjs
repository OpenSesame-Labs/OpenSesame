/**
 * Stage the Client CLI for npm pack/publish at a planned version.
 * Publishes as @opensesame-labs/cli with bin `opensesame`.
 * Sourcemaps are removed. Unpacked dist/ must stay within
 * CLI_RELEASE_DIST_BUDGET_BYTES.
 */
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NPM_PUBLISH } from "./npm-publish-names.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cliRoot = join(root, "packages/cli");
const releaseDir = join(cliRoot, "release");

/**
 * Unpacked release dist/ ceiling.
 * Run 41557074557 shipped 67.8 MB unpacked, about 49 MB of it sourcemaps.
 * Without maps the tree is about 17 MB. 32 MiB stays under that incident.
 */
export const CLI_RELEASE_DIST_BUDGET_BYTES = 32 * 1024 * 1024;

export function assertCliReleaseDistBudget(bytes) {
  if (!Number.isInteger(bytes) || bytes < 0) {
    throw new Error("staged CLI dist size is not a byte count");
  }
  if (bytes > CLI_RELEASE_DIST_BUDGET_BYTES) {
    throw new Error(
      `staged CLI dist is ${bytes} bytes, over ${CLI_RELEASE_DIST_BUDGET_BYTES}`,
    );
  }
}

async function walkRelease(directory, visit) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walkRelease(path, visit);
    else if (entry.isFile()) await visit(path, entry.name);
  }
}

async function removeSourceMaps(directory) {
  await walkRelease(directory, async (path, name) => {
    if (name.endsWith(".map")) await rm(path);
  });
}

async function directoryBytes(directory) {
  let total = 0;
  await walkRelease(directory, async (path) => {
    total += (await stat(path)).size;
  });
  return total;
}

export async function stageCliRelease(version) {
  if (!/^[^\s+]+$/u.test(version)) {
    throw new Error("VERSION must be semver without +build metadata");
  }
  const manifest = JSON.parse(
    await readFile(join(cliRoot, "package.json"), "utf8"),
  );
  await rm(releaseDir, { recursive: true, force: true });
  await mkdir(releaseDir, { recursive: true });
  await cp(join(cliRoot, "dist"), join(releaseDir, "dist"), {
    recursive: true,
  });
  await cp(join(cliRoot, "README.md"), join(releaseDir, "README.md"));
  await removeSourceMaps(releaseDir);
  await assertCliReleaseDistBudget(
    await directoryBytes(join(releaseDir, "dist")),
  );
  const publishManifest = {
    name: NPM_PUBLISH.cli.name,
    version,
    type: "module",
    description: manifest.description,
    bin: NPM_PUBLISH.cli.bin,
    exports: manifest.exports,
    files: ["dist", "!dist/**/*.map"],
    engines: { node: ">=24" },
    publishConfig: { access: "public", provenance: true },
    repository: manifest.repository,
    license: manifest.license,
    dependencies: {
      "@types/node": manifest.devDependencies["@types/node"],
      "agent-browser": manifest.dependencies["agent-browser"],
    },
  };
  await writeFile(
    join(releaseDir, "package.json"),
    `${JSON.stringify(publishManifest, null, 2)}\n`,
  );
  return releaseDir;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const version = process.env.VERSION ?? "";
  if (!version) throw new Error("VERSION is required");
  await stageCliRelease(version);
}
