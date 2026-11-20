// scripts/security/removed-dependencies.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// scripts/lib/json-boundary.mjs
function hasPrimitiveTag(value, tag) {
  return (
    Object(value) !== value && Object.prototype.toString.call(value) === tag
  );
}
function isString(value) {
  return hasPrimitiveTag(value, "[object String]");
}
function isJsonObject(value) {
  return (
    value !== null &&
    Object(value) === value &&
    !Array.isArray(value) &&
    !Object.prototype.toString.call(value).endsWith("Function]")
  );
}

// scripts/security/removed-dependencies.test.mjs
var removed = /* @__PURE__ */ new Set(["braces", "node-forge", "jks-js"]);
var lock = JSON.parse(
  readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"),
);
function packageName(key) {
  const parts = key.split("node_modules/");
  return parts.length > 1 ? parts.at(-1) : void 0;
}
function assertAllowedReference(reference) {
  if (!isString(reference)) return;
  for (const name of removed) {
    assert.ok(
      !reference.startsWith(`${name}@`) && reference !== name,
      `Removed dependency alias: ${reference}`,
    );
  }
}
test("removed vulnerable devtools dependencies have no lockfile edges", () => {
  assert.ok(lock.lockfileVersion >= 3);
  const packages = lock.packages ?? {};
  assert.ok(isJsonObject(packages), "lockfile packages is an object");
  for (const [key, entry] of Object.entries(packages)) {
    const name = packageName(key);
    if (name !== void 0) {
      assert.ok(!removed.has(name), `Removed dependency package: ${key}`);
    }
    if (isString(entry?.name)) {
      assert.ok(
        !removed.has(entry.name),
        `Removed dependency name: ${entry.name}`,
      );
    }
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
    ]) {
      for (const dep of Object.keys(entry?.[field] ?? {})) {
        assert.ok(!removed.has(dep), `Removed dependency edge: ${dep}`);
        assertAllowedReference(dep);
      }
    }
  }
});

// scripts/security/glob-abort-compatibility.test.mjs
import assert2 from "node:assert/strict";
import { readdir } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test as test2 } from "node:test";
import { pathToFileURL } from "node:url";

var root = resolve(import.meta.dirname, "../..");
var consumers = ["archiver-utils", "workbox-build", "promptfoo"];
async function fill(root3, depth) {
  if (depth === 0) return;
  for (let index = 0; index < 4; index++) {
    const child = join(root3, `d${index}`);
    await mkdir(child);
    await fill(child, depth - 1);
  }
}
async function abortWalk(glob, directory, stream) {
  const controller = new AbortController();
  let reads = 0;
  let afterAbort = 0;
  const fs = {
    readdir(path, options2, callback) {
      reads++;
      if (controller.signal.aborted) afterAbort++;
      readdir(path, options2, (error, entries) => {
        if (reads === 1) controller.abort(new Error("probe abort"));
        callback(error, entries);
      });
    },
  };
  const options = { cwd: directory, signal: controller.signal, fs };
  if (stream) {
    await new Promise((done, reject) => {
      const walk = glob.globStream("**/*", options);
      walk.on("error", (error) =>
        error.message === "probe abort" ? done() : reject(error),
      );
      walk.on("end", () => reject(new Error("walk did not reject")));
      walk.resume();
    });
  } else {
    await assert2.rejects(glob.glob("**/*", options), /probe abort/);
  }
  await new Promise((done) => setTimeout(done, 100));
  assert2.equal(reads, 1);
  assert2.equal(afterAbort, 0);
}
test2(
  "glob 10, 11 and 13 stop both promise and stream traversal after abort",
  {
    timeout: 3e4,
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "glob-abort-"));
    try {
      await fill(directory, 3);
      for (const consumer of consumers) {
        const require3 = createRequire(
          join(root, "node_modules", consumer, "package.json"),
        );
        const entry = require3.resolve("glob");
        const packageRoot = dirname(dirname(dirname(entry)));
        const esm = await import(
          pathToFileURL(join(packageRoot, "dist/esm/index.js")).href
        );
        for (const glob of [require3("glob"), esm]) {
          await abortWalk(glob, directory, false);
          await abortWalk(glob, directory, true);
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

// scripts/security/glob-backport-consumers.test.mjs
import assert3 from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync as readFileSync2,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire as createRequire2 } from "node:module";
import { tmpdir as tmpdir2 } from "node:os";
import {
  dirname as dirname2,
  join as join2,
  relative,
  resolve as resolve2,
} from "node:path";
import { test as test3 } from "node:test";
import { pathToFileURL as pathToFileURL2 } from "node:url";

var require2 = createRequire2(import.meta.url);
var root2 = resolve2(import.meta.dirname, "../..");
var local = (path) =>
  createRequire2(join2(root2, "node_modules", path, "package.json"));
function fixture() {
  const directory = mkdtempSync(join2(tmpdir2(), "glob-backport-"));
  mkdirSync(join2(directory, "src", "nested"), { recursive: true });
  for (const name of [
    "src/a.js",
    "src/a.test.js",
    "src/nested/b.js",
    "src/styles.css",
    "src/readme.md",
    "10000.txt",
  ]) {
    writeFileSync(join2(directory, name), name);
  }
  return directory;
}
test3(
  "archive and Workbox retain large brace-pattern matches",
  {
    timeout: 3e4,
  },
  () => {
    const directory = fixture();
    try {
      const archive = require2("archiver-utils/file.js");
      assert3.deepEqual(archive.expand({ cwd: directory }, "{0..10000}.txt"), [
        "10000.txt",
      ]);
      const workboxGlob = createRequire2(
        join2(root2, "node_modules/workbox-build/package.json"),
      ).resolve("glob");
      const workboxMatcher = createRequire2(workboxGlob).resolve("minimatch");
      const { braceExpand: workboxBraceExpand } = require2(workboxMatcher);
      assert3.equal(workboxBraceExpand("{1..100001}.txt").length, 100000);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
test3("promptfoo expands its actual file references", async () => {
  const directory = fixture();
  try {
    const src = join2(root2, "node_modules/promptfoo/dist/src");
    const name = readdirSync(src).find(
      (file) =>
        /^file-.*\.js$/.test(file) &&
        readFileSync2(join2(src, file), "utf8").includes(
          "maybeLoadFromExternalFile",
        ),
    );
    assert3.ok(name, "promptfoo file loader missing");
    const module = await import(pathToFileURL2(join2(src, name)).href);
    const files = module.a(`file://${directory}/src/*.js`).sort();
    assert3.deepEqual(files, ["src/a.js", "src/a.test.js"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test3(
  "filesystem search and Stryker retain their minimatch behavior",
  async () => {
    const directory = fixture();
    try {
      const server = await import(
        pathToFileURL2(
          join2(
            root2,
            "node_modules/@modelcontextprotocol/server-filesystem/dist/lib.js",
          ),
        ).href
      );
      server.setAllowedDirectories([directory]);
      const matches = await server.searchFilesWithValidation(
        directory,
        "**/*.js",
        [directory],
        {
          excludePatterns: ["**/*.test.js"],
        },
      );
      assert3.deepEqual(
        matches.map((path) => relative(directory, path)).sort(),
        ["src/a.js", "src/nested/b.js"],
      );
      const { FileMatcher } = await import(
        pathToFileURL2(
          join2(
            root2,
            "node_modules/@stryker-mutator/core/dist/src/config/file-matcher.js",
          ),
        ).href
      );
      const matcher = new FileMatcher(
        join2(directory, "src", "**", "*.{js,css}"),
      );
      assert3.equal(matcher.matches(join2(directory, "src", "a.js")), true);
      assert3.equal(
        matcher.matches(join2(directory, "src", "readme.md")),
        false,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
test3(
  "Storybook docgen uses the TypeScript 6 compiler API while root keeps 7",
  {
    timeout: 3e4,
  },
  async () => {
    const pluginRequire = local(
      "@joshwooding/vite-plugin-react-docgen-typescript",
    );
    const parserRequire = local("react-docgen-typescript");
    assert3.ok(pluginRequire("typescript").JsxEmit);
    assert3.strictEqual(
      pluginRequire("typescript"),
      parserRequire("typescript"),
    );
    assert3.equal(require2("typescript").version, "7.0.2");
    const directory = fixture();
    try {
      const file = join2(directory, "src", "Widget.tsx");
      const source =
        "export interface Props { label: string }\nexport function Widget(props: Props) { return null }\n";
      writeFileSync(file, source);
      const plugin = (
        await import("@joshwooding/vite-plugin-react-docgen-typescript")
      ).default({ include: ["**/*.tsx"], compilerOptions: {} });
      await plugin.configResolved({ root: directory, command: "build" });
      const output = await plugin.transform.call(
        {
          addWatchFile() {},
          warn(error) {
            throw new Error(error);
          },
        },
        source,
        file,
      );
      assert3.ok(output?.code?.includes("Widget"));
      assert3.ok(output.code.includes("label"));
      plugin.closeBundle();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
test3(
  "the compatible minimatch 9 and 11 builds bound globstar expansion",
  {
    timeout: 3e4,
  },
  async () => {
    for (const owner of ["archiver-utils", "workbox-build"]) {
      const glob = local(owner).resolve("glob");
      const matcher = createRequire2(glob).resolve("minimatch");
      const esm = pathToFileURL2(
        join2(dirname2(dirname2(dirname2(matcher))), "dist/esm/index.js"),
      ).href;
      const maximum = owner === "workbox-build" ? 128 : 65536;
      for (const { Minimatch, minimatch } of [
        require2(matcher),
        await import(esm),
      ]) {
        const pattern = Array(14).fill("**/../a/b").join("/");
        if (owner === "workbox-build") {
          assert3.throws(
            () =>
              new Minimatch(pattern, {
                optimizationLevel: 2,
                braceExpandMax: 128,
              }),
            RangeError,
          );
        } else {
          const bounded = new Minimatch(pattern, {
            optimizationLevel: 2,
            braceExpandMax: 128,
          });
          assert3.ok(bounded.globParts.length <= maximum);
        }
        assert3.equal(new Minimatch("**/*.js").match("src/a.js"), true);
        if (owner !== "workbox-build") continue;
        const invalidOption = new Minimatch("x", {
          braceExpandMax: Number.NaN,
        });
        assert3.throws(
          () =>
            invalidOption.firstPhasePreProcess({
              length: 1e5,
              *[Symbol.iterator]() {
                yield ["**", "..", "a", "b"];
              },
              push() {
                throw new Error("NaN bypassed the glob-part bound");
              },
            }),
          /NaN bypassed the glob-part bound/,
        );
        assert3.equal(
          minimatch
            .defaults({ braceExpandMax: Number.NaN })
            .braceExpand("{1..100001}").length,
          100000,
        );
        assert3.equal(
          minimatch
            .defaults({ braceExpandMax: "invalid" })
            .braceExpand("{1..100001}").length,
          100000,
        );
        assert3.equal(
          minimatch
            .defaults({ braceExpandMax: Number.POSITIVE_INFINITY })
            .braceExpand("{1..100001}").length,
          100001,
        );
      }
    }
  },
);
