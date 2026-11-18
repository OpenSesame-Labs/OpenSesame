import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
    const p = requireFromParent("picomatch");
    for (const [pattern, input] of [
      ["+(*a)", `${"a".repeat(35)}b`],
      ["+(ab|abab)c", `${"ab".repeat(40)}x`],
      ["+(a)*(a)b", `${"a".repeat(60_000)}c`],
    ]) {
      assert.throws(() => p.isMatch(input, pattern), /exceeded/);
    }
    // A timed-out worker is replaced and normal matching still works.
    assert.equal(p.isMatch("db.key", "+(*.key|*.pem)"), true);
    assert.equal(p.isMatch("db.key", "!+(*.key|*.pem)"), false);
  });

  test(`picomatch ${entry.version}: the regex worker inherits Node's permission arguments`, () => {
    const implementation = readFileSync(
      join(packageDirectory, "lib/bounded-regex.js"),
      "utf8",
    );
    assert.match(
      implementation,
      /new Worker\(`\$\{__dirname\}\/bounded-worker\.js`, \{ workerData: \{ ready \} \}\)/,
    );
    assert.doesNotMatch(implementation, /execArgv\s*:/);

    // Prove the regression check detects the previously shipped option that
    // discarded the parent Node permission arguments.
    const broken = implementation.replace(
      "{ workerData: { ready } }",
      "{ workerData: { ready }, execArgv: [] }",
    );
    assert.notEqual(broken, implementation);
    assert.match(broken, /execArgv\s*:/);
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
      const patterns = ["*.js", "**/*.js", "**/*.{js,ts}", "src/**/*.ts"];
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
      for (const glob of patterns)
        assert.equal(patched.makeRe(glob).constructor, RegExp);
      // A non-global RegExp ignores lastIndex, even when it is not coercible.
      const nonGlobal = patched.makeRe("**/*.{js,ts}");
      nonGlobal.lastIndex = Symbol("ignored");
      assert.throws(() => nonGlobal.exec("src/example.ts"), TypeError);

      // Risky extglobs retain their published matching semantics through the
      // bounded matcher, without exposing the underlying regular expression.
      for (const pattern of [
        "+(*.key|*.pem)",
        "!+(*.key|*.pem)",
        "+(a*(a))b",
        "+(ab|abab)c",
        "+(a*)*",
        "+(*a)",
        "+(a*|b)",
      ]) {
        const expected = upstream.makeRe(pattern);
        const matcher = patched(pattern);
        for (const input of inputs) {
          expected.lastIndex = 0;
          assert.equal(matcher(input), expected.test(input));
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test(`picomatch ${entry.version}: public compile APIs never expose risky regex source or objects`, () => {
    const p = requireFromParent("picomatch");
    const parse = createRequire(join(packageDirectory, "package.json"))(
      "./lib/parse",
    );
    const risky = [
      "+(*a)",
      "+(*a|b)z",
      "+(a*(a))b",
      "+(ab|abab)c",
      "+(a)*b",
      "+(a)*(a)b",
    ];
    for (const pattern of risky) {
      const state = parse(pattern, { fastpaths: false });
      assert.throws(() => p.parse(pattern), /refuses to expose/);
      assert.throws(() => p.compileRe(state), /refuses to expose/);
      assert.throws(() => p.compileRe(state, {}, true), /refuses to expose/);
      assert.throws(() => p.makeRe(pattern), /refuses to expose/);
      assert.throws(() => p.makeRe(pattern, {}, true), /refuses to expose/);
      const matcher = p(pattern, {}, true);
      const result = matcher("aaa", true);
      assert.equal(matcher.state, undefined);
      assert.equal(result.state, undefined);
      assert.equal(result.regex, undefined);
      assert.throws(
        () => RegExp.prototype.exec.call(result.regex, "aaa"),
        TypeError,
      );
      assert.throws(
        () => RegExp.prototype.test.call(result.regex, "aaa"),
        TypeError,
      );
    }
    assert.throws(() => p.toRegex("^(a+)(a*)b$"), /refuses to expose/);

    // Internal authorization is held in private closures, not passed through
    // overridable public functions where a caller could capture and replay it.
    const publicCompileRe = p.compileRe;
    const publicMakeRe = p.makeRe;
    const publicToRegex = p.toRegex;
    p.compileRe =
      p.makeRe =
      p.toRegex =
        () => {
          throw new Error("public compile hook reached");
        };
    try {
      assert.equal(p.isMatch("aaa", "+(*a)"), true);
    } finally {
      p.compileRe = publicCompileRe;
      p.makeRe = publicMakeRe;
      p.toRegex = publicToRegex;
    }
    assert.throws(() => p.makeRe("+(*a)"), /refuses to expose/);

    const safeState = p.parse("**/*.{js,ts}");
    const safeOutput = p.compileRe(safeState, {}, true);
    const safeRegex = p.makeRe("**/*.{js,ts}");
    assert.equal(new RegExp(safeOutput).test("src/example.ts"), true);
    assert.equal(
      RegExp.prototype.exec.call(safeRegex, "src/example.ts")[0],
      "src/example.ts",
    );
    assert.equal(RegExp.prototype.test.call(safeRegex, "src/example.js"), true);
    assert.equal(p.isMatch("foo.js", "@(foo|bar).js"), true);
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
