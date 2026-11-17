import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { applyPatch, extract, root } from "./patched-dependencies.mjs";

const versions = [
  {
    version: "2.3.2",
    parent: "node_modules/@aklinker1/rollup-plugin-visualizer/package.json",
    tarball: "patches/vendor/picomatch-2.3.2.tgz",
    patch: "patches/picomatch@2.3.2.patch",
  },
  {
    version: "4.0.7",
    parent: "package.json",
    tarball: "patches/vendor/picomatch-4.0.7.tgz",
    patch: "patches/picomatch@4.0.7.patch",
  },
];

function child(packageDirectory, script, timeout = 10000) {
  return spawnSync(process.execPath, ["-e", script, packageDirectory], {
    encoding: "utf8",
    timeout,
    maxBuffer: 64 * 1024,
  });
}

const attacks = `
  const assert = require('node:assert/strict');
  const p = require(process.argv[1]);
  const cases = [
    ['+(*a)', 'a'.repeat(35) + 'b'],
    ['+(*a|b)z', 'a'.repeat(35) + 'x'],
    ['+(a*(a))b', 'a'.repeat(40) + 'x'],
    ['+(ab|abab)c', 'ab'.repeat(40) + 'x'],
  ];
  for (const [pattern, input] of cases) {
    assert.throws(() => p.isMatch(input, pattern), /exceeded/);
  }
  // A timed-out worker is replaced and normal matching still works.
  assert.equal(p.isMatch('db.key', '+(*.key|*.pem)'), true);
  assert.equal(p.isMatch('db.key', '!+(*.key|*.pem)'), false);
`;

for (const entry of versions) {
  const requireFromParent = createRequire(resolve(root, entry.parent));
  const packageDirectory = join(
    resolve(requireFromParent.resolve("picomatch/package.json")),
    "..",
  );

  test(`picomatch ${entry.version}: repeated extglobs stop at a deadline`, () => {
    assert.equal(
      requireFromParent("picomatch/package.json").version,
      entry.version,
    );
    const result = child(packageDirectory, attacks);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  });

  test(`picomatch ${entry.version}: ordinary matching and captures match the published package`, () => {
    const directory = mkdtempSync(join(tmpdir(), "opensesame-picomatch-"));
    try {
      const original = extract(join(root, entry.tarball), directory);
      applyPatch(original, entry.patch, true);
      const upstream = createRequire(join(original, "package.json"))(
        "./index.js",
      );
      const patched = requireFromParent("picomatch");
      const patterns = [
        "+(*.key|*.pem)",
        "!+(*.key|*.pem)",
        "+(a*(a))b",
        "+(ab|abab)c",
        "+(a*)*",
        "+(*a)",
        "+(a*|b)",
        "src/**/*.ts",
      ];
      const inputs = ["db.key", "db.pem", "db.txt", "abc", "aab", "src/x.ts"];
      for (const options of [
        {},
        { dot: true },
        { windows: true },
        { capture: true },
        { contains: true },
        { flags: "dg" },
      ]) {
        for (const pattern of patterns) {
          const expected = upstream.makeRe(pattern, options);
          const actual = patched.makeRe(pattern, options);
          assert.equal(actual.source, expected.source);
          assert.equal(actual.flags, expected.flags);
          for (const input of inputs) {
            actual.lastIndex = 0;
            expected.lastIndex = 0;
            assert.deepEqual(actual.exec(input), expected.exec(input));
            assert.equal(actual.lastIndex, expected.lastIndex);
          }
        }
      }
      for (const glob of ["*.js", "**/*.js", "**/*.{js,ts}"])
        assert.equal(patched.makeRe(glob).constructor, RegExp);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test(`picomatch ${entry.version}: the published package reproduces the issue`, () => {
    const directory = mkdtempSync(join(tmpdir(), "opensesame-picomatch-"));
    try {
      const original = extract(join(root, entry.tarball), directory);
      applyPatch(original, entry.patch, true);
      const result = child(
        original,
        "require(process.argv[1]).isMatch('a'.repeat(35) + 'b', '+(*a)')",
        500,
      );
      assert.equal(result.error?.code, "ETIMEDOUT");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("Rollup consumers keep excluding keys matched by a repeated extglob", () => {
  const requireFromRoot = createRequire(join(root, "package.json"));
  const { createFilter } = requireFromRoot("@rollup/pluginutils");
  const { createFilter: visualizer } = requireFromRoot(
    "@aklinker1/rollup-plugin-visualizer/dist/shared/create-filter.js",
  );
  for (const [path, expected] of [
    ["dir/db.key", false],
    ["dir/db.pem", false],
    ["dir/db.txt", true],
  ]) {
    assert.equal(createFilter(null, "**/+(*.key|*.pem)")(path), expected);
    assert.equal(
      visualizer([], [{ file: "**/+(*.key|*.pem)" }])("bundle", path),
      expected,
    );
  }
});
