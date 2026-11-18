import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  parsePushRefs,
  parseRegistry,
  planPush,
} from "./formal-proof-push-gate.mjs";
import {
  fixture,
  installHook,
  nil,
  push,
  registry,
} from "./formal-proof-push-gate.test.fixture.mjs";

test("rejects malformed refs and registry without executing Git or proofs", () => {
  const oid = "a".repeat(40);
  for (const input of [
    `refs/heads/a ${oid} refs/heads/a ${nil} \n`,
    `refs/heads/a ${oid} refs/heads/a bad\n`,
    `refs/heads/a ${oid} refs/heads/../bad ${nil}\n`,
    `refs/heads/a ${nil} refs/heads/a ${oid}\n`,
    `(delete) ${nil} refs/heads/a ${nil}\n`,
    `refs/heads/a ${oid} refs/heads/a ${nil}\n\n`,
    `refs/heads/a ${oid} refs/heads/a ${nil}\nrefs/heads/b ${oid} refs/heads/a ${nil}\n`,
  ])
    assert.throws(() => parsePushRefs(Buffer.from(input)), /Malformed/);
  assert.deepEqual(parsePushRefs(Buffer.alloc(0)), []);
  assert.throws(
    () => parseRegistry(Buffer.from('{"version":1,"suites":[]}')),
    /Invalid/,
  );
  assert.throws(
    () =>
      parseRegistry(
        Buffer.from(
          JSON.stringify({
            ...registry,
            suites: [{ ...registry.suites[0], command: ["sh", "-c", "true"] }],
          }),
        ),
      ),
    /Invalid/,
  );
});

test("registry boundaries reject non-string ids, paths and commands", () => {
  for (const value of [null, 7, true, {}, []]) {
    for (const suite of [
      { ...registry.suites[0], id: value },
      { ...registry.suites[0], implementation: [value] },
      { ...registry.suites[0], proofs: [value] },
      { ...registry.suites[0], command: ["npm", "run", value] },
    ]) {
      const input = Buffer.from(
        JSON.stringify({ version: 1, suites: [suite] }),
      );
      assert.throws(() => parseRegistry(input), /Invalid formal proof suite/);
    }
  }
});

test("runs only suites mapped to the pushed implementation and propagates failure", (t) => {
  const f = fixture(t);
  f.write("src/a", "a1\n");
  const target = f.commit();
  const result = f.run(f.tuple(target));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.commands(), ["run verify:a"]);
  const failure = f.run(f.tuple(target), { FORMAL_TEST_STATUS: "9" });
  assert.notEqual(failure.status, 0);
  assert.match(failure.stderr, /suite a failed/);
});

test("ignores unrelated and proof-only changes, but detects add, delete and rename", (t) => {
  for (const operation of ["other", "proof", "add", "delete", "rename"]) {
    const f = fixture(t);
    if (operation === "other") f.write("src/other", "changed\n");
    if (operation === "proof") f.write("spec/formal/a/proof", "changed\n");
    if (operation === "add") f.write("src/added", "added\n");
    if (operation === "delete") rmSync(join(f.repo, "src/a"));
    if (operation === "rename")
      renameSync(join(f.repo, "src/a"), join(f.repo, "src/renamed"));
    const target = f.commit();
    const result = f.run(f.tuple(target));
    assert.equal(result.status, 0, `${operation}: ${result.stderr}`);
    assert.deepEqual(
      f.commands(),
      ["add", "delete", "rename"].includes(operation) ? ["run verify:a"] : [],
      operation,
    );
  }
});

test("new branches compare against the actual remote history, and deletion-only updates skip proof", (t) => {
  for (const changed of ["src/other", "src/b"]) {
    const f = fixture(t);
    f.write(changed, "new branch\n");
    const target = f.commit();
    const result = f.run(f.tuple(target, nil, "refs/heads/new"));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(f.commands(), changed === "src/b" ? ["run verify:b"] : []);
    const deletion = f.run(f.tuple(nil));
    assert.equal(deletion.status, 0, deletion.stderr);
  }
});

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
  const changedDuringProof = f.run(f.tuple(target));
  assert.notEqual(changedDuringProof.status, 0);
  assert.match(changedDuringProof.stderr, /assume-unchanged and skip-worktree/);
});

test("fetches previously unknown remote tips to compare a new branch accurately", (t) => {
  const f = fixture(t);
  const other = join(f.dir, "other");
  mkdirSync(other);
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: other,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("fetch", "-q", f.remote, "refs/heads/main");
  git("checkout", "-q", "-b", "other", "FETCH_HEAD");
  writeFileSync(join(other, "src/b"), "remote branch\n");
  git("add", "src/b");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "remote change");
  const remoteTip = git("rev-parse", "HEAD");
  git(
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "-q",
    f.remote,
    "HEAD:refs/heads/other",
  );
  assert.notEqual(
    spawnSync("git", ["cat-file", "-e", remoteTip], { cwd: f.repo }).status,
    0,
  );
  f.write("src/a", "local branch\n");
  const target = f.commit();
  const result = f.run(f.tuple(target, nil, "refs/heads/new"));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.commands(), ["run verify:a"]);
  assert.equal(
    spawnSync("git", ["cat-file", "-e", remoteTip], { cwd: f.repo }).status,
    0,
  );
});

test("selects all changed paths in pushed history, including changes subsequently reverted", (t) => {
  const f = fixture(t);
  f.write("src/a", "intermediate\n");
  f.commit();
  f.write("src/a", "a0\n");
  const target = f.commit();
  const result = f.run(f.tuple(target));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.commands(), ["run verify:a"]);
});

test("plans multiple refs and refuses to verify non-HEAD commits or dirty source", (t) => {
  const f = fixture(t);
  f.write("src/a", "a1\n");
  const first = f.commit();
  f.write("src/b", "b1\n");
  const second = f.commit();
  const input =
    f.tuple(first, f.base, "refs/heads/a") +
    f.tuple(second, first, "refs/heads/b");
  const plan = planPush(f.repo, parsePushRefs(Buffer.from(input)), "origin");
  assert.deepEqual(
    plan.map((p) => [p.target, p.suites.map((s) => s.id)]),
    [
      [first, ["a"]],
      [second, ["b"]],
    ],
  );
  const multi = f.run(input);
  assert.notEqual(multi.status, 0);
  assert.match(multi.stderr, /non-HEAD commit or multiple pushed tips/);
  assert.deepEqual(f.commands(), []);
  f.write("src/other", "dirty\n");
  const dirty = f.run(f.tuple(second));
  assert.notEqual(dirty.status, 0);
  assert.match(dirty.stderr, /clean worktree/);
  assert.deepEqual(f.commands(), []);
});

test("a dirty or removed registry cannot mask a previously mapped implementation", (t) => {
  const f = fixture(t);
  f.write("src/a", "changed\n");
  const target = f.commit();
  f.write(
    "spec/formal/proof-registry.json",
    JSON.stringify({ version: 1, suites: [registry.suites[1]] }),
  );
  const dirty = f.run(f.tuple(target));
  assert.notEqual(dirty.status, 0);
  assert.match(dirty.stderr, /clean worktree/);
  f.commit();
  const removed = f.git("rev-parse", "HEAD");
  const result = f.run(f.tuple(removed));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /removes required formal proof suite a/);
  assert.deepEqual(f.commands(), []);
});
