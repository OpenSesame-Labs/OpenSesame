import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

test("local proof plans do not query npm for a publish version", (t) => {
  const root = mkdtempSync(join(tmpdir(), "npm-proof-version-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sentinel = join(root, "npm-called");
  writeFileSync(
    join(root, "npm"),
    '#!/bin/sh\nprintf called > "$NPM_PROOF_SENTINEL"\nexit 99\n',
    { mode: 0o755 },
  );
  const env = {
    PATH: root,
    NPM_PRERELEASE_ID: "beta",
    NPM_PROOF_SENTINEL: sentinel,
  };
  const planners = [
    ["plan-cli-release.mjs", ["--mode", "cd"]],
    ["plan-pages-release.mjs", []],
  ];
  for (const [script, args] of planners) {
    const command = resolve(import.meta.dirname, script);
    const result = spawnSync(
      process.execPath,
      [command, ...args, "--local-proof", "--sha", "abcdef0"],
      { env, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^version=0\.0\.0-alpha\.0$/m);
    assert.equal(existsSync(sentinel), false);
  }
  for (const [script, args] of planners) {
    const ordinary = spawnSync(
      process.execPath,
      [resolve(import.meta.dirname, script), ...args, "--sha", "abcdef0"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(ordinary.status, 0);
    assert.equal(existsSync(sentinel), true);
    unlinkSync(sentinel);
  }
  writeFileSync(join(root, "npm"), "#!/bin/sh\nprintf '[\"0.0.0-beta.2\"]'\n", {
    mode: 0o755,
  });
  for (const [script, args] of planners) {
    const ordinary = spawnSync(
      process.execPath,
      [resolve(import.meta.dirname, script), ...args, "--sha", "abcdef0"],
      { env, encoding: "utf8" },
    );
    assert.equal(ordinary.status, 0, ordinary.stderr);
    assert.match(ordinary.stdout, /^version=0\.0\.0-beta\.3$/m);
  }
  const invalidMode = spawnSync(
    process.execPath,
    [
      resolve(import.meta.dirname, "plan-cli-release.mjs"),
      "--mode",
      "alpha",
      "--local-proof",
      "--sha",
      "abcdef0",
    ],
    { env, encoding: "utf8" },
  );
  assert.notEqual(invalidMode.status, 0);
  assert.match(invalidMode.stderr, /--local-proof requires --mode cd/);
});
