import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
// npm installs the patched tarball at the lockfile's js-yaml 3.15.2 location.
const lock = JSON.parse(
  readFileSync(path.join(root, "package-lock.json"), "utf8"),
);
const patched = Object.entries(lock.packages)
  .filter(([key]) => key.endsWith("node_modules/js-yaml"))
  .filter(([, entry]) => entry.version === "3.15.2")
  .filter(([, entry]) => entry.resolved?.startsWith("file:patches/vendor/"))
  .map(([key]) => key);
const cli =
  process.env.JS_YAML_COMPAT_CLI ??
  (patched.length === 1
    ? path.join(root, patched[0], "bin/js-yaml.js")
    : undefined);
assert.ok(cli, "Expected one installed patched js-yaml 3.15.2 CLI");
const requireFromCli = createRequire(cli);
assert.equal(requireFromCli("argparse/package.json").version, "2.0.1");

function invoke(args, input) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    input,
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.error, undefined);
  return result;
}

test("js-yaml 3 retains help and version with argparse 2", () => {
  const help = invoke(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--compact/);
  assert.match(help.stdout, /--trace/);
  const version = invoke(["--version"]);
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), "3.15.2");
});

test("js-yaml 3 retains stdin load, dump and hidden compatibility flag", () => {
  for (const args of [[], ["-j"]]) {
    const loaded = invoke(args, "key: value\nlist: [1, 2]\n");
    assert.equal(loaded.status, 0);
    assert.deepEqual(JSON.parse(loaded.stdout), { key: "value", list: [1, 2] });
  }
  const dumped = invoke([], '{"key":"value","list":[1,2]}');
  assert.equal(dumped.status, 0);
  assert.deepEqual(requireFromCli("../index.js").load(dumped.stdout), {
    key: "value",
    list: [1, 2],
  });
});

test("js-yaml 3 retains compact, trace and parser failure exits", () => {
  for (const args of [["--compact"], ["--trace"]]) {
    const refused = invoke(args, "a: [unterminated");
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /YAMLException/);
  }
  assert.equal(invoke(["--unknown"]).status, 2);
  assert.equal(invoke(["/nonexistent/compatibility-fixture.yaml"]).status, 2);
});
