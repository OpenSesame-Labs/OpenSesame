import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { repoRootFromHere } from "../lib/ci-changed-areas.mjs";

const root = repoRootFromHere();
const manifest = join(root, "Cargo.toml");
const resolver = join(import.meta.dirname, "cargo-built-executable.mjs");

const hasCargo =
  existsSync(manifest) &&
  spawnSync("cargo", ["--version"], { encoding: "utf8" }).status === 0;

const skipWithoutCargo = hasCargo
  ? false
  : "cargo or Cargo.toml is unavailable";

const invalidBinArgs = [
  "build",
  "--locked",
  "-p",
  "opensesame-cli",
  "--bin",
  "__opensesame_ci_invalid_bin__",
  "--message-format=json-render-diagnostics",
];

test("surfaces rustc errors on stderr when the bin name is invalid", {
  skip: skipWithoutCargo,
}, () => {
  const build = spawnSync("cargo", invalidBinArgs, {
    cwd: root,
    encoding: "utf8",
  });
  assert.notEqual(build.status, 0);
  const combined = `${build.stderr}\n${build.stdout}`;
  assert.match(combined, /error/i);
});

test("keeps stderr visible while piping stdout JSON through the resolver", {
  skip: skipWithoutCargo,
}, () => {
  const build = spawnSync("cargo", invalidBinArgs, {
    cwd: root,
    encoding: "utf8",
  });
  assert.notEqual(build.status, 0);
  assert.match(build.stderr, /error/i);

  const resolve = spawnSync(process.execPath, [resolver, "opensesame"], {
    input: build.stdout,
    encoding: "utf8",
  });
  assert.notEqual(resolve.status, 0);
});
