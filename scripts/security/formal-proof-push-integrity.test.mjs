import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  fixture,
  installHook,
  push,
} from "./formal-proof-push-gate.test.fixture.mjs";

test("new branches use the push URL rather than fetch-side history", (t) => {
  const f = fixture(t);
  const pushRemote = join(f.dir, "destination.git");
  execFileSync("git", ["init", "--bare", "-q", pushRemote]);
  f.git(
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "-q",
    pushRemote,
    `${f.base}:refs/heads/main`,
  );
  f.write("src/a", "present only on fetch side\n");
  f.commit();
  installHook(f);
  f.git(
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "-q",
    "origin",
    "HEAD:refs/heads/existing",
  );
  f.git("remote", "set-url", "--push", "origin", pushRemote);
  const result = push(f, "HEAD", "refs/heads/new");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.commands(), ["run verify:a"]);
});

test("rejects index flags that hide changed proof bytes only when proofs are selected", (t) => {
  for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
    const f = fixture(t);
    f.write("src/a", "mapped\n");
    const target = f.commit();
    f.git("update-index", flag, "spec/formal/a/proof");
    f.write("spec/formal/a/proof", "altered proof\n");
    assert.equal(f.git("status", "--porcelain"), "");
    const result = f.run(f.tuple(target));
    assert.notEqual(result.status, 0, flag);
    assert.match(result.stderr, /assume-unchanged and skip-worktree/);
    assert.deepEqual(f.commands(), []);
    const unrelated = f.run(f.tuple(f.base));
    assert.equal(unrelated.status, 0, unrelated.stderr);
    assert.deepEqual(f.commands(), []);
  }
  const f = fixture(t);
  f.write("src/a", "mapped\n");
  const target = f.commit();
  writeFileSync(
    join(f.bin, "npm"),
    "#!/bin/sh\ngit update-index --assume-unchanged spec/formal/a/proof\nprintf altered >> spec/formal/a/proof\n",
    { mode: 0o755 },
  );
  const result = f.run(f.tuple(target));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /assume-unchanged and skip-worktree/);
});
