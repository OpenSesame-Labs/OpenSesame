import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  fixture,
  installHook,
  push,
} from "./formal-proof-push-gate.test.fixture.mjs";

test("moving an annotated tag fetches its missing peeled object", (t) => {
  const f = fixture(t);
  installHook(f);
  f.git(
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "-q",
    "origin",
    "HEAD:refs/heads/main",
  );
  const gitRemote = (args, input) =>
    spawnSync("git", ["--git-dir", f.remote, ...args], {
      input,
      encoding: "utf8",
    });
  const blob = gitRemote(
    ["hash-object", "-w", "--stdin"],
    "remote-only peeled object\n",
  );
  assert.equal(blob.status, 0, blob.stderr);
  const oldBlob = blob.stdout.trim();
  const tagBody = `object ${oldBlob}\ntype blob\ntag legacy\ntagger Test <test@example.invalid> 0 +0000\n\nlegacy\n`;
  const tagged = gitRemote(
    ["hash-object", "-t", "tag", "-w", "--stdin"],
    tagBody,
  );
  assert.equal(tagged.status, 0, tagged.stderr);
  const oldTag = tagged.stdout.trim();
  assert.equal(gitRemote(["update-ref", "refs/tags/legacy", oldTag]).status, 0);
  const copyTagOnly = spawnSync(
    "git",
    ["hash-object", "-t", "tag", "-w", "--stdin"],
    {
      cwd: f.repo,
      input: tagBody,
      encoding: "utf8",
    },
  );
  assert.equal(copyTagOnly.status, 0, copyTagOnly.stderr);
  assert.equal(copyTagOnly.stdout.trim(), oldTag);
  assert.equal(
    spawnSync("git", ["cat-file", "-e", `${oldTag}^{object}`], { cwd: f.repo })
      .status,
    0,
  );
  assert.notEqual(
    spawnSync("git", ["cat-file", "-e", oldBlob], { cwd: f.repo }).status,
    0,
  );
  f.write("src/a", "incoming change\n");
  f.commit();
  f.git("tag", "legacy", "HEAD");
  const result = push(f, "+refs/tags/legacy", "refs/tags/legacy");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.commands(), ["run verify:a"]);
  assert.equal(
    spawnSync("git", ["cat-file", "-e", oldBlob], { cwd: f.repo }).status,
    0,
  );
});
