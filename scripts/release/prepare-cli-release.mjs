/**
 * Stage the Client CLI for npm pack/publish at a planned version.
 * Publishes as @opensesame-labs/cli with bin `opensesame`.
 */
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NPM_PUBLISH } from "./npm-publish-names.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cliRoot = join(root, "packages/cli");
const releaseDir = join(cliRoot, "release");

export async function stageCliRelease(version) {
  if (!/^[^\s+]+$/u.test(version)) {
    throw new Error("VERSION must be semver without +build metadata");
  }
  const manifest = JSON.parse(
    await readFile(join(cliRoot, "package.json"), "utf8"),
  );
  await rm(releaseDir, { recursive: true, force: true });
  await mkdir(releaseDir, { recursive: true });
  await cp(join(cliRoot, "dist"), join(releaseDir, "dist"), { recursive: true });
  await cp(join(cliRoot, "README.md"), join(releaseDir, "README.md"));
  const publishManifest = {
    name: NPM_PUBLISH.cli.name,
    version,
    type: "module",
    description: manifest.description,
    bin: NPM_PUBLISH.cli.bin,
    exports: manifest.exports,
    files: ["dist"],
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
