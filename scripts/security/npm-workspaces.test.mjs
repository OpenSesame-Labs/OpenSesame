// work/npm-workspaces-base.mjs
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
import merge from "deepmerge";
import nunjucks from "nunjucks";

var root = join(dirname(fileURLToPath(import.meta.url)), "../..");
test("esbuild resolves to the declared version from both workspace consumers", () => {
  for (const workspace of ["packages/app-core", "packages/cli"]) {
    const fromWorkspace = Module.createRequire(
      join(root, workspace, "package.json"),
    );
    const manifest = fromWorkspace("esbuild/package.json");
    assert.equal(manifest.version, "0.28.2");
    assert.equal(
      manifest.version,
      fromWorkspace("./package.json").devDependencies.esbuild,
    );
  }
});
test("deepmerge rejects prototype keys while retaining ordinary nested data", () => {
  const source = JSON.parse(
    '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"nested":{"values":[2]}}',
  );
  const result = merge({ nested: { values: [1] } }, source);
  assert.deepEqual(result.nested.values, [1, 2]);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(result.polluted, undefined);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.hasOwn(result, "constructor"), false);
});
var patches = {
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
  "kdbxweb@2.1.1": "patches/kdbxweb@2.1.1.patch",
  "@aws-sdk/xml-builder@3.972.42":
    "patches/@aws-sdk__xml-builder@3.972.42.patch",
  "glob@10.5.0": "patches/glob@10.5.0.patch",
  "glob@11.1.0": "patches/glob@11.1.0.patch",
  "minimatch@9.0.9": "patches/minimatch@9.0.9.patch",
  "minimatch@10.2.6": "patches/minimatch@10.2.6.patch",
  "@joshwooding/vite-plugin-react-docgen-typescript@0.7.0":
    "patches/@joshwooding__vite-plugin-react-docgen-typescript@0.7.0.patch",
  "react-docgen-typescript@2.4.0":
    "patches/react-docgen-typescript@2.4.0.patch",
  "node-turn@0.0.6": "patches/node-turn@0.0.6.patch",
  "@noble/post-quantum@0.5.4": "patches/@noble__post-quantum@0.5.4.patch",
};
function read(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}
function workspaceGlobs(yaml) {
  return [...yaml.matchAll(/^\s*-\s*"([^"]+)"/gm)].map((match) => match[1]);
}
var legacy = "pnpm";
test("npm workspaces replace the legacy lockfile", () => {
  assert.equal(existsSync(join(root, `${legacy}-lock.yaml`)), false);
  assert.equal(existsSync(join(root, "package-lock.json")), true);
  const manifest = JSON.parse(read("package.json"));
  const lock = JSON.parse(read("package-lock.json"));
  assert.equal(manifest.packageManager, "npm@11.19.1");
  assert.equal(Object.hasOwn(manifest, legacy), false);
  assert.equal(manifest.engines.node, ">=24");
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
  assert.equal(overrides["@noble/post-quantum"], "$noble-post-quantum-patched");
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
      signal: AbortSignal.timeout(8e3),
    });
    const env = new nunjucks.Environment(loader);
    assert.equal(env.render(name, { name: "Ada" }), "Hello Ada");
    await added;
    const updated = once(loader, "update", {
      signal: AbortSignal.timeout(8e3),
    });
    await writeFile(file, "Changed {{ name }}");
    const [changed] = await updated;
    assert.equal(changed, name);
    assert.equal(env.render(name, { name: "Ada" }), "Changed Ada");
  } finally {
    if (loader) await loader.watcher.close();
    if (previousPath === void 0) delete process.env.NODE_PATH;
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

// scripts/security/npm-installed-bins.test.mjs
import assert2 from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir as tmpdir2 } from "node:os";
import { dirname as dirname2, join as join2 } from "node:path";
import { test as test2 } from "node:test";
import {
  installedNpmBins,
  npmCommandShim,
  withoutVerifiedNpmBins,
} from "./patched-dependencies.mjs";

var location = "node_modules/parent";
var packages = {
  [`${location}/node_modules/child`]: { bin: { tool: "bin/tool.js" } },
};
function fixture() {
  const root2 = mkdtempSync(join2(tmpdir2(), "opensesame-bin-test-"));
  const bin = join2(root2, "node_modules/.bin/tool");
  const source = join2(root2, "node_modules/child/bin/tool.js");
  mkdirSync(dirname2(bin), { recursive: true });
  mkdirSync(dirname2(source), { recursive: true });
  writeFileSync(source, "#!/usr/bin/env node\nconsole.log('tool')\n");
  return { root: root2, bin, source };
}
test2(
  "npm bin links must point to a declared direct child's bin",
  {
    skip: process.platform === "win32",
  },
  async () => {
    const { root: root2, bin } = fixture();
    try {
      symlinkSync("../child/bin/tool.js", bin);
      assert2.deepEqual(
        [...(await installedNpmBins(root2, location, packages))],
        ["node_modules/.bin/tool"],
      );
      assert2.deepEqual([...(await installedNpmBins(root2, location, {}))], []);
      assert2.deepEqual(
        [
          ...(await installedNpmBins(root2, location, {
            [`${location}/node_modules/child`]: {
              bin: { tool: "../outside.js" },
            },
          })),
        ],
        [],
      );
      unlinkSync(bin);
      symlinkSync("../child/package.json", bin);
      assert2.deepEqual(
        [...(await installedNpmBins(root2, location, packages))],
        [],
      );
      unlinkSync(bin);
      writeFileSync(bin, "unexpected executable");
      assert2.deepEqual(
        [...(await installedNpmBins(root2, location, packages))],
        [],
      );
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  },
);
test2(
  "Windows shims must exactly match the active npm-generated wrappers",
  async () => {
    const { root: root2, bin, source } = fixture();
    try {
      const shim = npmCommandShim();
      await shim(source, bin);
      const options = { platform: "win32", shim };
      assert2.deepEqual(
        [...(await installedNpmBins(root2, location, packages, options))],
        [
          "node_modules/.bin/tool",
          "node_modules/.bin/tool.cmd",
          "node_modules/.bin/tool.ps1",
        ],
      );
      appendFileSync(`${bin}.cmd`, "\r\nmalicious-command\r\n");
      assert2.deepEqual(
        [...(await installedNpmBins(root2, location, packages, options))],
        [],
      );
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  },
);
test2(
  "verified npm bins cannot mask files included in the patched tarball",
  () => {
    const actual = { "node_modules/.bin/tool": "changed", "index.js": "good" };
    const bins = /* @__PURE__ */ new Set(["node_modules/.bin/tool"]);
    assert2.deepEqual(
      { ...withoutVerifiedNpmBins({}, actual, bins) },
      { "index.js": "good" },
    );
    assert2.deepEqual(
      {
        ...withoutVerifiedNpmBins(
          { "node_modules/.bin/tool": "original" },
          actual,
          bins,
        ),
      },
      actual,
    );
  },
);
