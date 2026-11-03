import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { bundleDeclarations } from "./declarations.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "dist");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
// Workspace packages expose TypeScript sources. Bundle those sources so an
// installed CLI needs neither tsx nor the workspace's development dependencies.
// CLI_RELEASE_PACK=1 is the npm publish build. Sourcemaps stay out of that tarball.
const releasePack = process.env.CLI_RELEASE_PACK === "1";
await build({
  entryPoints: {
    bin: join(root, "src/bin.ts"),
    index: join(root, "src/index.ts"),
  },
  outdir: output,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: !releasePack,
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});
const require = createRequire(import.meta.url);
execFileSync(
  process.execPath,
  [
    join(dirname(require.resolve("typescript/package.json")), "bin/tsc"),
    "-p",
    join(root, "tsconfig.build.json"),
  ],
  { cwd: root, stdio: "inherit" },
);
await bundleDeclarations(root);
await chmod(join(output, "bin.js"), 0o755);
await cp(join(root, "src/parity-assets"), join(output, "parity-assets"), {
  recursive: true,
});
if (process.argv.includes("--native")) {
  const target = process.env.CARGO_TARGET_DIR;
  if (!target)
    throw new Error(
      "Release packaging requires CARGO_TARGET_DIR with a built native release companion.",
    );
  const name = process.platform === "win32" ? "opensesame.exe" : "opensesame";
  const source = join(target, "release", name);
  // Read before copying: a missing companion must fail the release build.
  if ((await readFile(source)).length === 0)
    throw new Error("Native companion is empty.");
  const destination = join(
    output,
    "native",
    `${process.platform}-${process.arch}`,
  );
  await mkdir(destination, { recursive: true });
  await cp(source, join(destination, name));
  await chmod(join(destination, name), 0o755);
}
