import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  fixture,
  installHook,
  nil,
  push,
} from "./formal-proof-push-gate.test.fixture.mjs";

test("a merge does not select an implementation already at the destination", (t) => {
  const f = fixture(t);
  installHook(f);
  const branch = f.git("symbolic-ref", "--short", "HEAD");
  f.git("checkout", "-qb", "topic");
  f.write("src/other", "topic change\n");
  f.commit();
  f.git("checkout", "-q", branch);
  f.write("src/a", "already at destination\n");
  f.commit();
  f.git(
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "-q",
    "origin",
    "HEAD:refs/heads/main",
  );
  const destination = f.git("rev-parse", "HEAD");
  f.git("checkout", "-q", "topic");
  f.git("merge", "--no-ff", "-qm", "merge destination", branch);
  assert.equal(f.git("diff", "--name-only", destination, "HEAD"), "src/other");
  const result = push(f, "HEAD", "refs/heads/main");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no mapped implementation changes/);
  assert.deepEqual(f.commands(), []);
});

test("a merge still checks a new implementation change later reverted", (t) => {
  const f = fixture(t);
  installHook(f);
  const branch = f.git("symbolic-ref", "--short", "HEAD");
  f.git("checkout", "-qb", "topic");
  f.write("src/b", "temporary change\n");
  f.commit();
  f.write("src/b", "b0\n");
  f.write("src/other", "topic change\n");
  f.commit();
  f.git("checkout", "-q", branch);
  f.write("src/a", "already at destination\n");
  f.commit();
  f.git(
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "-q",
    "origin",
    "HEAD:refs/heads/main",
  );
  const destination = f.git("rev-parse", "HEAD");
  f.git("checkout", "-q", "topic");
  f.git("merge", "--no-ff", "-qm", "merge destination", branch);
  assert.equal(f.git("diff", "--name-only", destination, "HEAD"), "src/other");
  const result = push(f, "HEAD", "refs/heads/main");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.commands(), ["run verify:b"]);
});

test("a new merge checks implementation changes made during conflict resolution", (t) => {
  const f = fixture(t);
  installHook(f);
  const branch = f.git("symbolic-ref", "--short", "HEAD");
  f.git("checkout", "-qb", "topic");
  f.write("src/a", "topic version\n");
  f.commit();
  f.git(
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "-q",
    "origin",
    "HEAD:refs/heads/topic",
  );
  f.git("checkout", "-q", branch);
  f.write("src/a", "destination version\n");
  f.commit();
  f.git(
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "-q",
    "origin",
    "HEAD:refs/heads/main",
  );
  f.git("checkout", "-q", "topic");
  const merge = spawnSync("git", ["merge", "--no-ff", "--no-commit", branch], {
    cwd: f.repo,
    encoding: "utf8",
  });
  assert.notEqual(merge.status, 0);
  f.write("src/a", "resolved version\n");
  f.git("add", "src/a");
  f.git("-c", "commit.gpgsign=false", "commit", "-qm", "resolve merge");
  const result = push(f, "HEAD", "refs/heads/merged");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.commands(), ["run verify:a"]);
});

test("non-commit tags skip proof suites without blocking Git push", (t) => {
  const f = fixture(t);
  installHook(f);
  const blob = f.git("rev-parse", "HEAD:src/other");
  const tree = f.git("rev-parse", "HEAD^{tree}");
  f.git("tag", "blob-tag", blob);
  f.git("tag", "tree-tag", tree);
  f.git("tag", "-a", "annotated-blob", "-m", "blob", blob);
  for (const name of ["blob-tag", "tree-tag", "annotated-blob"]) {
    const result = push(f, `refs/tags/${name}`, `refs/tags/${name}`);
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    assert.match(result.stdout, /no mapped implementation changes/);
  }
  assert.deepEqual(f.commands(), []);
  const missing = f.run(f.tuple("a".repeat(40), nil, "refs/tags/missing"));
  assert.notEqual(missing.status, 0);
});

test("moving a non-commit tag to a commit selects only changed implementations", (t) => {
  for (const oldType of ["blob", "tree", "annotated-blob"]) {
    for (const changed of ["src/a", "src/other"]) {
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
      const old = f.git(
        "rev-parse",
        oldType === "tree" ? "HEAD^{tree}" : "HEAD:src/other",
      );
      if (oldType === "annotated-blob")
        f.git("tag", "-a", "legacy", "-m", "legacy", old);
      else f.git("tag", "legacy", old);
      f.git(
        "-c",
        "core.hooksPath=/dev/null",
        "push",
        "-q",
        "origin",
        "refs/tags/legacy",
      );
      f.write(changed, "incoming change\n");
      f.commit();
      f.git("tag", "-f", "legacy", "HEAD");
      const result = push(f, "+refs/tags/legacy", "refs/tags/legacy");
      assert.equal(result.status, 0, `${oldType} ${changed}: ${result.stderr}`);
      assert.deepEqual(
        f.commands(),
        changed === "src/a" ? ["run verify:a"] : [],
      );
    }
  }
});

test("moving a tag with an unavailable old blob fetches it before selecting", (t) => {
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
  const written = spawnSync(
    "git",
    ["--git-dir", f.remote, "hash-object", "-w", "--stdin"],
    {
      input: "remote-only tag object\n",
      encoding: "utf8",
    },
  );
  assert.equal(written.status, 0, written.stderr);
  const old = written.stdout.trim();
  const remoteRef = spawnSync("git", [
    "--git-dir",
    f.remote,
    "update-ref",
    "refs/tags/legacy",
    old,
  ]);
  assert.equal(remoteRef.status, 0);
  assert.notEqual(
    spawnSync("git", ["cat-file", "-e", old], { cwd: f.repo }).status,
    0,
  );
  f.write("src/a", "incoming change\n");
  f.commit();
  f.git("tag", "legacy", "HEAD");
  const result = push(f, "+refs/tags/legacy", "refs/tags/legacy");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.commands(), ["run verify:a"]);
  assert.equal(
    spawnSync("git", ["cat-file", "-e", old], { cwd: f.repo }).status,
    0,
  );
});

function historicalPush(t, path) {
  const f = fixture(t);
  installHook(f);
  const currentBranch = f.git("symbolic-ref", "--short", "HEAD");
  f.git("checkout", "-q", "--orphan", "legacy");
  rmSync(join(f.repo, "spec/formal/proof-registry.json"));
  rmSync(join(f.repo, "spec/formal/proof-requirements.json"));
  const previous = f.commit();
  f.write(path, "historical change\n");
  f.commit();
  f.git("checkout", "-q", currentBranch);
  f.git(
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "-q",
    "origin",
    `${previous}:refs/heads/legacy`,
  );
  return { f, result: push(f, "legacy", "refs/heads/legacy") };
}

test("a historical non-HEAD push without a registry skips unrelated changes", (t) => {
  const { f, result } = historicalPush(t, "src/other");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no mapped implementation changes/);
  assert.deepEqual(f.commands(), []);
});

test("a historical non-HEAD push without a registry rejects mapped changes", (t) => {
  const { f, result } = historicalPush(t, "src/a");
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /formal proof registry is missing from pushed commit/i,
  );
  assert.deepEqual(f.commands(), []);
});

test("missing pushed or remote objects and an unavailable new-branch remote fail closed", (t) => {
  const f = fixture(t);
  for (const input of [
    f.tuple("a".repeat(40)),
    f.tuple(f.base, "a".repeat(40)),
  ]) {
    const result = f.run(input);
    assert.notEqual(result.status, 0);
    assert.deepEqual(f.commands(), []);
  }
  const missing = f.run(
    f.tuple(f.base, nil, "refs/heads/new"),
    {},
    "not-a-remote",
  );
  assert.notEqual(missing.status, 0);
});

test("a shallow repository cannot silently omit pushed history", (t) => {
  const f = fixture(t);
  f.write("src/a", "changed\n");
  const target = f.commit();
  f.write(".git/shallow", `${f.base}\n`);
  const result = f.run(f.tuple(target));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /shallow checkout/);
  assert.deepEqual(f.commands(), []);
});

test("a non-HEAD push with no mapped changes does not run a suite", (t) => {
  const f = fixture(t);
  f.write("src/other", "unrelated\n");
  const target = f.commit();
  f.write("src/a", "current head only\n");
  f.commit();
  const result = f.run(f.tuple(target));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.commands(), []);
});

test("a suite that changes the source during verification fails the push", (t) => {
  const f = fixture(t);
  f.write("src/a", "changed\n");
  const target = f.commit();
  const result = f.run(f.tuple(target), { FORMAL_TEST_MUTATE: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /changed the source tree/);
});

test("fetch-side history cannot suppress proofs for a separate push URL", (t) => {
  const f = fixture(t);
  installHook(f);
  const pushRemote = join(f.dir, "push.git");
  f.git("init", "--bare", "-q", pushRemote);
  f.git(
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "-q",
    pushRemote,
    "HEAD:refs/heads/main",
  );
  f.write("src/a", "present on the fetch remote only\n");
  f.commit();
  f.git(
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "-q",
    f.remote,
    "HEAD:refs/heads/already",
  );
  f.git("remote", "set-url", "--push", "origin", pushRemote);
  const required = push(f, "HEAD", "refs/heads/new", "9");
  assert.notEqual(required.status, 0);
  assert.match(required.stderr, /suite a failed/);
  assert.deepEqual(f.commands(), ["run verify:a"]);
  f.git(
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "-q",
    pushRemote,
    "HEAD:refs/heads/already",
  );
  rmSync(f.log, { force: true });
  const covered = push(f, "HEAD", "refs/heads/other", "9");
  assert.equal(covered.status, 0, covered.stderr);
  assert.match(covered.stdout, /no mapped implementation changes/);
  assert.deepEqual(f.commands(), []);
});

test("a native Git push invokes the hook with its actual ref stream and propagates proof failure", (t) => {
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
  f.write("src/a", "pushed source\n");
  f.commit();
  const success = push(f, "HEAD", "refs/heads/main");
  assert.equal(success.status, 0, success.stderr);
  assert.deepEqual(f.commands(), ["run verify:a"]);
  const failure = push(f, "HEAD", "refs/heads/main", "9");
  assert.notEqual(failure.status, 0);
  assert.match(failure.stderr, /suite a failed/);
});
