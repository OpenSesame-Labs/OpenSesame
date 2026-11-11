import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import {
  artifactPaths,
  assertImmutableArtifacts,
  integrity,
  manifestPath,
  releaseManifest,
  validateStaticAuth,
} from "../../../scripts/lib/static-auth-artifacts.mjs";

const root = new URL("../../../", import.meta.url);
const git = (args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const packageJson = JSON.parse(
  await readFile(new URL("packages/static-auth/package.json", root)),
);
const version = packageJson.version;
const [hostedPath, frozenPath] = artifactPaths(version);

async function bundle(entry) {
  const result = await build({
    configFile: false,
    envFile: false,
    root: fileURLToPath(root),
    logLevel: "error",
    resolve: {
      alias: {
        "@opensesame/os-domain": fileURLToPath(
          new URL("packages/os-domain/src/browser.ts", root),
        ),
      },
    },
    build: {
      write: false,
      target: "es2022",
      minify: "esbuild",
      lib: {
        entry: fileURLToPath(new URL(entry, root)),
        name: "OpenSesameStaticAuth",
        formats: ["iife"],
      },
      // Rollup always emitted "use strict"; Rolldown only copies it from source.
      rollupOptions: { output: { strict: true } },
    },
  });
  const output = Array.isArray(result) ? result[0] : result;
  assert.ok(output && "output" in output, "Expected static-auth build");
  assert.equal(output.output.length, 1, "Unexpected SDK output");
  assert.equal(output.output[0].type, "chunk");
  return output.output[0].code;
}

async function readOptional(path) {
  try {
    return await readFile(new URL(path, root), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  }
}

assert.ok(
  process.argv.length <= 3 &&
    (!process.argv[2] || process.argv[2] === "--check"),
  "Usage: build-static-auth.mjs [--check]",
);
const check = process.argv[2] === "--check";
const existingManifest = check
  ? validateStaticAuth(fileURLToPath(root))
  : undefined;
const base = process.env.LINT_SINCE ?? "origin/main";
git(["rev-parse", "--verify", `${base}^{commit}`]);
const publishedManifest = git([
  "ls-tree",
  "--name-only",
  base,
  "--",
  manifestPath,
])
  ? JSON.parse(git(["show", `${base}:${manifestPath}`]))
  : undefined;
if (publishedManifest && existingManifest)
  assertImmutableArtifacts(publishedManifest, existingManifest);
const hosted = await bundle("packages/static-auth/src/browser.ts");
// ADR 0096: the root alias is frozen and hash-ratcheted. A bundler update cannot
// reproduce its bytes, so its published SRI is carried forward, never rebuilt.
const frozen = await readFile(new URL(frozenPath, root), "utf8");
const artifacts = [
  { path: hostedPath, sri: integrity(hosted) },
  { path: frozenPath, sri: integrity(frozen) },
];
const outputs = [
  [hostedPath, hosted],
  [`${hostedPath}.sha384`, `${artifacts[0].sri}\n`],
];
// Check every output before writing any; never partially replace a frozen release.
for (const [path, bytes] of outputs) {
  const previous = await readOptional(path);
  if (check || previous !== undefined)
    assert.ok(previous === bytes, `Static-auth bytes changed: ${path}`);
}
if (check) {
  console.log(
    "static-auth: exact inventory, hashes, syntax and source rebuild CLEAN",
  );
} else {
  const inputs = [
    "packages/static-auth",
    "packages/sdk-browser",
    "packages/browser-at-rest",
    "packages/os-domain",
    "package-lock.json",
    "package.json",
    "apps/pages/scripts/build-static-auth.mjs",
    "scripts/lib/static-auth-artifacts.mjs",
  ];
  assert.equal(
    git(["status", "--porcelain", "--untracked-files=all", "--", ...inputs]),
    "",
    "Commit SDK build inputs before generating release provenance",
  );
  const prior = await readOptional(manifestPath);
  const manifest = releaseManifest(
    version,
    git(["rev-parse", "HEAD"]),
    artifacts,
    prior ? JSON.parse(prior) : undefined,
  );
  if (publishedManifest) assertImmutableArtifacts(publishedManifest, manifest);
  for (const [path, bytes] of [...outputs]) {
    await mkdir(dirname(fileURLToPath(new URL(path, root))), {
      recursive: true,
    });
    if ((await readOptional(path)) === undefined)
      await writeFile(new URL(path, root), bytes, { flag: "wx" });
  }
  await writeFile(
    new URL(manifestPath, root),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  validateStaticAuth(fileURLToPath(root));
  console.log(
    `static-auth: generated ${version} from committed source ${manifest.sourceCommit}`,
  );
}
