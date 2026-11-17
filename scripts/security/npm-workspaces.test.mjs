import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import Module from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { transform, transformSync } from "@esbuild-kit/core-utils";
import nunjucks from "nunjucks";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

const patches = {
  "js-yaml@3.15.2": "patches/js-yaml@3.15.2.patch",
  "@simple-git/argv-parser@2.0.1":
    "patches/@simple-git__argv-parser@2.0.1.patch",
  "@devicefarmer/adbkit@3.3.8": "patches/@devicefarmer__adbkit@3.3.8.patch",
  "@levischuck/tiny-cbor@0.2.11": "patches/@levischuck__tiny-cbor@0.2.11.patch",
  "@levischuck/tiny-cbor@0.3.6": "patches/@levischuck__tiny-cbor@0.3.6.patch",
  "picomatch@2.3.2": "patches/picomatch@2.3.2.patch",
  "picomatch@4.0.7": "patches/picomatch@4.0.7.patch",
  "typed-rest-client@2.3.1": "patches/typed-rest-client@2.3.1.patch",
  "@esbuild-kit/core-utils@3.3.2":
    "patches/@esbuild-kit__core-utils@3.3.2.patch",
  "nunjucks@3.2.4": "patches/nunjucks@3.2.4.patch",
};

function read(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

function workspaceGlobs(yaml) {
  return [...yaml.matchAll(/^\s*-\s*"([^"]+)"/gm)].map((match) => match[1]);
}

const legacy = "pn" + "pm";

test("npm workspaces replace the legacy lockfile", () => {
  assert.equal(existsSync(join(root, `${legacy}-lock.yaml`)), false);
  assert.equal(existsSync(join(root, "package-lock.json")), true);
  const manifest = JSON.parse(read("package.json"));
  const lock = JSON.parse(read("package-lock.json"));
  assert.equal(manifest.packageManager, "npm@11.19.1");
  assert.equal(Object.hasOwn(manifest, legacy), false);
  assert.equal(manifest.engines.node, ">=24");
  // assert.match rejects anything that is not a string.
  assert.match(manifest.devDependencies.turbo, /\S/);
  assert.ok(lock.lockfileVersion >= 3);
  assert.equal(lock.packages[""].name, "opensesame");
  const former = workspaceGlobs(read(`${legacy}-workspace.yaml`));
  assert.deepEqual(manifest.workspaces, former);
  assert.deepEqual(former, [
    "apps/*",
    "packages/*",
    "examples/*",
    "tests/redteam",
    "tests/visual-contract",
    "tests/fuzz/jazzer",
    "tools/mock-upstream-idp",
    "tools/oxlint/anti-slop",
  ]);
});

test("patched dependencies are referenced from patchedDependencies", () => {
  const manifest = JSON.parse(read("package.json"));
  assert.deepEqual(manifest.patchedDependencies, patches);
  // npm rejects the patch: URL protocol (EUNSUPPORTEDPROTOCOL) and ignores
  // patchedDependencies, which only names the files. Each patch is installed
  // from a tarball under patches/vendor/ that the root depends on and an
  // override points at (scripts/security/patched-dependencies.test.mjs).
  const overrides = manifest.overrides;
  assert.equal(JSON.stringify(overrides).includes("patch:"), false);
  assert.equal(overrides["js-yaml@^3"], "$js-yaml");
  assert.equal(overrides["picomatch@^2"], "$picomatch-v2-patched");
  assert.equal(overrides["picomatch@^4"], "$picomatch-v4-patched");
  assert.equal(overrides["typed-rest-client"], "$typed-rest-client");
  assert.equal(
    overrides["@esbuild-kit/core-utils"],
    "$@esbuild-kit/core-utils",
  );
  assert.equal(overrides.nunjucks, "$nunjucks");
  assert.equal(overrides["js-yaml@3.15.2"].argparse, "2.0.1");
  assert.equal(
    overrides["@simple-git/argv-parser"],
    "$@simple-git/argv-parser",
  );
  assert.equal(
    overrides["@levischuck/tiny-cbor@^0.2"],
    "$@levischuck/tiny-cbor",
  );
  assert.equal(
    overrides["@levischuck/tiny-cbor@^0.3"],
    "$tiny-cbor-v3-patched",
  );
  assert.equal(overrides["@devicefarmer/adbkit"]["."], "3.3.8");
  assert.equal(overrides["@devicefarmer/adbkit"]["node-forge"], "-");
  assert.equal(overrides.promptfoo["jks-js"], "-");
  assert.equal(overrides.promptfoo["@huggingface/transformers"], "-");
  // chokidar 3 pulls braces. The removed-dependencies gate forbids braces,
  // and the previous package-manager tree only resolved chokidar 5.
  assert.equal(overrides["chokidar@^3"], "5.0.0");
  for (const [selector, file] of Object.entries(patches)) {
    assert.equal(existsSync(join(root, file)), true, file);
    assert.equal(manifest.patchedDependencies[selector], file);
  }
});

test("root scripts and the install script do not invoke the legacy package manager", () => {
  const manifest = JSON.parse(read("package.json"));
  for (const [name, script] of Object.entries(manifest.scripts)) {
    assert.equal(script.includes(legacy), false, name);
  }
  const install = read("scripts/dev/install-dependencies.sh");
  const workspaceFile = `${legacy}-workspace.yaml`;
  // The workspace glob file is still hashed. Nothing in the script runs the legacy manager.
  assert.match(install, new RegExp(workspaceFile.replaceAll(".", "\\.")));
  assert.equal(install.replaceAll(workspaceFile, "").includes(legacy), false);
  assert.match(install, /npm ci/);
  assert.match(install, /package-lock\.json/);
});

test("the installed Nunjucks loader watches and reloads a resolved template", async () => {
  const temp = await mkdtemp(join(tmpdir(), "opensesame-nunjucks-watch-"));
  const name = `synthetic-template-${process.pid}`;
  const directory = join(temp, "node_modules", name);
  const file = join(directory, "template.njk");
  const previousPath = process.env.NODE_PATH;
  let loader;
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ name, main: "template.njk" }),
    );
    await writeFile(file, "Hello {{ name }}");
    process.env.NODE_PATH = [join(temp, "node_modules"), previousPath]
      .filter(Boolean)
      .join(delimiter);
    Module._initPaths();
    loader = new nunjucks.NodeResolveLoader({ watch: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const added = once(loader.watcher, "add", {
      signal: AbortSignal.timeout(8000),
    });
    const env = new nunjucks.Environment(loader);
    assert.equal(env.render(name, { name: "Ada" }), "Hello Ada");
    await added;
    const updated = once(loader, "update", {
      signal: AbortSignal.timeout(8000),
    });
    await writeFile(file, "Changed {{ name }}");
    const [changed] = await updated;
    assert.equal(changed, name);
    assert.equal(env.render(name, { name: "Ada" }), "Changed Ada");
  } finally {
    if (loader) await loader.watcher.close();
    if (previousPath === undefined) delete process.env.NODE_PATH;
    else process.env.NODE_PATH = previousPath;
    Module._initPaths();
    await rm(temp, { recursive: true, force: true });
  }
});

function expectValue(result) {
  const module = { exports: {} };
  runInNewContext(result.code, { exports: module.exports, module });
  assert.equal(module.exports.value, 42);
  assert.ok(result.map);
}

test("the installed esbuild-kit consumer transforms TypeScript synchronously and asynchronously", async () => {
  const source = "export const value: number = 42;";
  expectValue(transformSync(source, "/tmp/fixture.ts", { format: "cjs" }));
  expectValue(
    await transform(source, "/tmp/fixture-async.ts", { format: "cjs" }),
  );
});
