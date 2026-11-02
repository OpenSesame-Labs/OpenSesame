/**
 * Stage env-spec-bridge for npm publish as @opensesame-labs/env-spec-bridge.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "../../packages/env-spec-bridge/scripts/bundle.mjs";
import { NPM_PUBLISH } from "./npm-publish-names.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packageRoot = join(root, "packages/env-spec-bridge");
const releaseDir = join(packageRoot, "release");

export async function stageEnvSpecRelease(version) {
  if (!/^[^\s+]+$/u.test(version)) {
    throw new Error("VERSION must be semver without +build metadata");
  }
  const manifest = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
  await rm(releaseDir, { recursive: true, force: true });
  await mkdir(releaseDir, { recursive: true });
  const bundled = await bundle(join(releaseDir, "opensesame-env-parse.mjs"));
  const publishManifest = {
    name: NPM_PUBLISH.envSpecBridge.name,
    version,
    type: "module",
    description: manifest.description,
    bin: NPM_PUBLISH.envSpecBridge.bin,
    files: ["opensesame-env-parse.mjs", "README.md"],
    engines: { node: ">=24" },
    publishConfig: { access: "public", provenance: true },
    repository: manifest.repository,
    license: manifest.license,
  };
  await writeFile(
    join(releaseDir, "package.json"),
    `${JSON.stringify(publishManifest, null, 2)}\n`,
  );
  await writeFile(
    join(releaseDir, "README.md"),
    `# ${NPM_PUBLISH.envSpecBridge.name}\n\nStandalone \`opensesame-env-parse\` bundle (${bundled}).\n`,
  );
  return releaseDir;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const version = process.env.VERSION ?? "";
  if (!version) throw new Error("VERSION is required");
  await stageEnvSpecRelease(version);
}
