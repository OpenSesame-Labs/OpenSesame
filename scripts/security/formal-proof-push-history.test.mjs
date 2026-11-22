import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  fixture,
  installHook,
  push,
  registry,
} from "./formal-proof-push-gate.test.fixture.mjs";

const registryPath = "spec/formal/proof-registry.json";
const manifest = "spec/formal/proof-requirements.json";

function initialize(t) {
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
  return { f, base: f.git("rev-parse", "HEAD") };
}

function writePolicy(f, value, both = true) {
  f.write(registryPath, JSON.stringify(value));
  if (both) f.write(manifest, JSON.stringify(value));
}

function extendPolicy() {
  const extended = structuredClone(registry);
  extended.suites[0].implementation.push("src/other");
  return extended;
}

function transientMapping(f, { both, revertSource }) {
  writePolicy(f, extendPolicy(), both);
  f.commit();
  f.write("src/other", "covered change\n");
  f.commit();
  writePolicy(f, registry, both);
  if (revertSource) f.write("src/other", "other\n");
  f.commit();
}

test("native pushes reject transient registry-only and jointly pinned mappings", (t) => {
  for (const both of [false, true]) {
    for (const revertSource of [false, true]) {
      const { f } = initialize(t);
      transientMapping(f, { both, revertSource });
      const result = push(f, "HEAD", "refs/heads/main");
      assert.notEqual(
        result.status,
        0,
        `both=${both} reverted=${revertSource}`,
      );
      assert.match(
        result.stderr,
        both
          ? /removes required formal proof mapping a: src\/other/
          : /does not match required mappings/,
      );
      assert.deepEqual(f.commands(), []);
    }
  }
});

test("a newly pinned mapping runs its suite when the source changes", (t) => {
  const { f } = initialize(t);
  const extended = extendPolicy();
  f.pin(extended);
  writePolicy(f, extended);
  f.commit();
  f.write("src/other", "covered change\n");
  f.commit();
  const result = push(f, "HEAD", "refs/heads/main");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.commands(), ["run verify:a"]);
});

test("transient consistent policy changes alone do not run proofs", (t) => {
  const { f } = initialize(t);
  writePolicy(f, extendPolicy());
  f.commit();
  writePolicy(f, registry);
  f.commit();
  const result = push(f, "HEAD", "refs/heads/main");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.commands(), []);
});

test("a mapped change cannot shed an intermediate proof or command", (t) => {
  for (const kind of ["proof", "command"]) {
    const { f } = initialize(t);
    const altered = structuredClone(registry);
    if (kind === "proof")
      altered.suites[0].proofs = ["spec/formal/a/alternate"];
    else altered.suites[0].command = ["npm", "run", "verify:alternate"];
    writePolicy(f, altered);
    f.commit();
    f.write("src/a", "implementation while policy differs\n");
    f.commit();
    writePolicy(f, registry);
    f.commit();
    const result = push(f, "HEAD", "refs/heads/main");
    assert.notEqual(result.status, 0, kind);
    assert.match(result.stderr, /changes the formal proof contract for a/);
    assert.deepEqual(f.commands(), []);
  }
});

test("a suite contract change and implementation change require separate pushes", (t) => {
  const { f } = initialize(t);
  const altered = structuredClone(registry);
  altered.suites[0].proofs = ["spec/formal/a/alternate"];
  altered.suites[0].command = ["npm", "run", "verify:alternate"];
  f.pin(altered);
  writePolicy(f, altered);
  f.write("spec/formal/a/alternate", "new proof\n");
  f.write("src/a", "implementation with new proof\n");
  f.commit();
  const result = push(f, "HEAD", "refs/heads/main");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /changes the formal proof contract for a/);
  assert.deepEqual(f.commands(), []);
});

test("a separately pushed suite change permits later source changes despite an older tag", (t) => {
  const { f } = initialize(t);
  f.git("tag", "old-release");
  f.git(
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "-q",
    "origin",
    "refs/tags/old-release",
  );
  const altered = structuredClone(registry);
  altered.suites[0].proofs = ["spec/formal/a/alternate"];
  altered.suites[0].command = ["npm", "run", "verify:alternate"];
  f.pin(altered);
  writePolicy(f, altered);
  f.write("spec/formal/a/alternate", "new proof\n");
  f.commit();
  const metadata = push(f, "HEAD", "refs/heads/main");
  assert.equal(metadata.status, 0, metadata.stderr);
  assert.deepEqual(f.commands(), []);
  f.git(
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "-q",
    "origin",
    "HEAD:refs/heads/main",
  );
  f.write("src/a", "implementation with new proof\n");
  f.commit();
  const result = push(f, "HEAD", "refs/heads/new");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.commands(), ["run verify:alternate"]);
});

test("stale new and existing branches cannot omit a mapping pinned on remote main", (t) => {
  for (const existing of [false, true]) {
    const { f, base } = initialize(t);
    f.git("branch", "stale", base);
    if (existing)
      f.git(
        "-c",
        "core.hooksPath=/dev/null",
        "push",
        "-q",
        "origin",
        "stale:refs/heads/stale",
      );
    const extended = extendPolicy();
    f.pin(extended);
    writePolicy(f, extended);
    f.commit();
    f.git(
      "-c",
      "core.hooksPath=/dev/null",
      "push",
      "-q",
      "origin",
      "HEAD:refs/heads/main",
    );
    f.git("checkout", "-q", "stale");
    f.write("src/other", "changed from stale branch\n");
    f.commit();
    const result = push(f, "HEAD", "refs/heads/stale");
    assert.notEqual(result.status, 0, `existing=${existing}`);
    assert.match(
      result.stderr,
      /removes required formal proof mapping a: src\/other/,
    );
    assert.deepEqual(f.commands(), []);
  }
});

test("an annotated tag cannot conceal transient mapping and reverted source", (t) => {
  const { f } = initialize(t);
  transientMapping(f, { both: true, revertSource: true });
  f.git("tag", "-a", "release", "-m", "release");
  const result = push(f, "refs/tags/release", "refs/tags/release");
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /removes required formal proof mapping a: src\/other/,
  );
  assert.deepEqual(f.commands(), []);
});

test("one invalid history blocks a native push containing multiple refs", (t) => {
  const { f, base } = initialize(t);
  transientMapping(f, { both: true, revertSource: true });
  f.git("branch", "unsafe");
  f.git("checkout", "-qb", "safe", base);
  f.write("src/safe", "unrelated\n");
  f.commit();
  f.git("checkout", "-q", "unsafe");
  const result = spawnSync(
    "git",
    [
      "-c",
      "core.hooksPath=.githooks",
      "push",
      "--dry-run",
      "origin",
      "refs/heads/safe:refs/heads/safe",
      "refs/heads/unsafe:refs/heads/unsafe",
    ],
    {
      cwd: f.repo,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${f.bin}:${process.env.PATH}`,
        FORMAL_TEST_LOG: f.log,
        OPENSESAME_PREPUSH: "off",
      },
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /removes required formal proof mapping a: src\/other/,
  );
  assert.deepEqual(f.commands(), []);
});

test("a merge preserves mappings from a side history even after source and metadata are reverted", (t) => {
  const { f } = initialize(t);
  const branch = f.git("symbolic-ref", "--short", "HEAD");
  f.git("checkout", "-qb", "topic");
  transientMapping(f, { both: true, revertSource: true });
  f.git("checkout", "-q", branch);
  f.write("src/new", "destination change\n");
  f.commit();
  f.git(
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "-q",
    "origin",
    "HEAD:refs/heads/main",
  );
  f.git("merge", "--no-ff", "-qm", "merge topic", "topic");
  const result = push(f, "HEAD", "refs/heads/main");
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /removes required formal proof mapping a: src\/other/,
  );
  assert.deepEqual(f.commands(), []);
});

test("a merge retains the mapping of an already-remote parent", (t) => {
  const { f, base } = initialize(t);
  f.git("checkout", "-qb", "mapped");
  writePolicy(f, extendPolicy());
  f.commit();
  f.git(
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "-q",
    "origin",
    "HEAD:refs/heads/mapped",
  );
  f.git("checkout", "-qb", "incoming", base);
  f.write("src/other", "incoming source change\n");
  f.commit();
  f.git("merge", "--no-ff", "--no-commit", "mapped");
  writePolicy(f, registry);
  f.git("add", registryPath, manifest);
  f.git(
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "discard mapping in merge",
  );
  const result = push(f, "HEAD", "refs/heads/merged");
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /removes required formal proof mapping a: src\/other/,
  );
  assert.deepEqual(f.commands(), []);
});

test("a merge retains the proof contract of an already-remote parent", (t) => {
  const { f, base } = initialize(t);
  f.git("checkout", "-qb", "proof-b");
  const altered = structuredClone(registry);
  altered.suites[0].proofs = ["spec/formal/a/alternate"];
  altered.suites[0].command = ["npm", "run", "verify:alternate"];
  writePolicy(f, altered);
  f.write("spec/formal/a/alternate", "alternate proof\n");
  f.commit();
  f.git(
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "-q",
    "origin",
    "HEAD:refs/heads/proof-b",
  );
  f.git("checkout", "-qb", "incoming", base);
  f.write("src/a", "incoming source change\n");
  f.commit();
  f.git("merge", "--no-ff", "--no-commit", "proof-b");
  writePolicy(f, registry);
  f.git("add", registryPath, manifest);
  f.git(
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "retain original contract",
  );
  const result = push(f, "HEAD", "refs/heads/merged");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /changes the formal proof contract for a/);
  assert.deepEqual(f.commands(), []);
});
