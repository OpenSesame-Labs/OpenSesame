import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
    ['+(a)*b', 'a'.repeat(60000) + 'c'],
    ['+(a)*(a)b', 'a'.repeat(60000) + 'c'],
  ];
  for (const [pattern, input] of cases) {
    assert.throws(() => p.isMatch(input, pattern), /exceeded/);
  }
  const direct = p.toRegex('^(a+)(a*)b$');
  assert.throws(() => direct.test('a'.repeat(60000) + 'c'), /exceeded/);
  assert.equal(p.toRegex('^abc$').test('abc'), true);
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

  test(`picomatch ${entry.version}: the regex worker inherits Node's permission model`, () => {
    const directory = mkdtempSync(
      join(tmpdir(), "opensesame-picomatch-permission-"),
    );
    try {
      const allowed = join(directory, "allowed");
      mkdirSync(allowed);
      const packageDirectory = extract(join(root, entry.tarball), allowed);
      const denied = join(directory, "denied.txt");
      writeFileSync(denied, "private test fixture");
      const worker = join(packageDirectory, "lib/bounded-worker.js");
      const guard = `
        if (!process.permission || process.permission.has('fs.read', process.env.OPENSESAME_PICOMATCH_DENIED_PATH)) {
          const ready = new Int32Array(require('node:worker_threads').workerData.ready);
          Atomics.store(ready, 0, 1);
          Atomics.notify(ready, 0);
          throw new Error('worker did not inherit filesystem restrictions');
        }
      `;
      writeFileSync(worker, guard + readFileSync(worker, "utf8"));
      const script = `
        const assert = require('node:assert/strict');
        const p = require(process.argv[1]);
        assert.equal(process.permission.has('fs.read', process.env.OPENSESAME_PICOMATCH_DENIED_PATH), false);
        assert.equal(p.isMatch('aa', '+(*a)'), true);
        assert.throws(() => p.isMatch('a'.repeat(35) + 'b', '+(*a)'), /exceeded/);
      `;
      const run = () =>
        spawnSync(
          process.execPath,
          [
            "--permission",
            `--allow-fs-read=${allowed}`,
            "--allow-worker",
            "-e",
            script,
            packageDirectory,
          ],
          {
            encoding: "utf8",
            timeout: 10000,
            env: { ...process.env, OPENSESAME_PICOMATCH_DENIED_PATH: denied },
          },
        );
      const restricted = run();
      assert.ifError(restricted.error);
      assert.equal(restricted.status, 0, restricted.stderr);

      // Prove this assertion catches the previously shipped worker options.
      const implementation = join(packageDirectory, "lib/bounded-regex.js");
      const original = readFileSync(implementation, "utf8");
      const broken = original.replace(
        "{ workerData: { ready } }",
        "{ workerData: { ready }, execArgv: [] }",
      );
      assert.notEqual(broken, original);
      writeFileSync(implementation, broken);
      const unrestricted = run();
      assert.ifError(unrestricted.error);
      assert.notEqual(
        unrestricted.status,
        0,
        "a worker with no restrictions must fail the guard",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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
      // A non-global RegExp ignores lastIndex, even when it is not coercible.
      const nonGlobal = patched.makeRe("+(*a)");
      nonGlobal.lastIndex = Symbol("ignored");
      assert.equal(nonGlobal.exec("aaa")?.[0], "aaa");
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
