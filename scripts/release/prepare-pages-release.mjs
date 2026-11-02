/**
 * Stage the built GitHub Pages PWA for npm pack/publish at a planned version.
 */
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NPM_PUBLISH } from "./npm-publish-names.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pagesRoot = join(root, "apps/pages");
const distDir = join(pagesRoot, "dist");
const releaseDir = join(pagesRoot, "release");
const serveSource = join(root, "scripts/release/pages-pwa-serve.mjs");

export async function stagePagesRelease(version) {
  if (!/^[^\s+]+$/u.test(version)) {
    throw new Error("VERSION must be semver without +build metadata");
  }
  const manifest = JSON.parse(
    await readFile(join(pagesRoot, "package.json"), "utf8"),
  );
  await rm(releaseDir, { recursive: true, force: true });
  await mkdir(join(releaseDir, "bin"), { recursive: true });
  await cp(distDir, join(releaseDir, "dist"), { recursive: true });
  await cp(serveSource, join(releaseDir, "bin/serve.mjs"));
  const readme = `# ${NPM_PUBLISH.webPwa.name}

Built static OpenSesame Pages PWA (GitHub Pages artifact).

After \`npm install\`, run \`npx opensesame-pages\` (or \`opensesame-pages\` when linked) to serve \`dist/\` on \`http://localhost:5180\`.
`;
  await writeFile(join(releaseDir, "README.md"), readme);
  const publishManifest = {
    name: NPM_PUBLISH.webPwa.name,
    version,
    type: "module",
    description: manifest.description,
    bin: NPM_PUBLISH.webPwa.bin,
    files: ["dist", "bin"],
    engines: { node: ">=24" },
    publishConfig: { access: "public", provenance: true },
    repository: {
      type: "git",
      url: "git+https://github.com/OpenSesame-Labs/OpenSesame.git",
      directory: "apps/pages",
    },
    license: "MIT",
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
  await stagePagesRelease(version);
}
