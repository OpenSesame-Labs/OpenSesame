import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

const requirements = JSON.parse(
  readFileSync(
    new URL("../../spec/formal/proof-requirements.json", import.meta.url),
    "utf8",
  ),
);

function seedRequiredSuite(f, suite) {
  f.pin(requirements);
  f.write(
    "scripts/security/formal-proof-manifest-set.mjs",
    readFileSync(new URL("./formal-proof-manifest-set.mjs", import.meta.url)),
  );
  for (const name of ["proof-registry", "proof-requirements"])
    f.write(`spec/formal/${name}.json`, JSON.stringify(requirements));
  for (const proof of suite.proofs) f.write(proof, "proof\n");
  f.write(suite.implementation[0], "original\n");
}

test("durable history and shared source modules select only their mapped proofs", (t) => {
  const cases = [
    [
      "crates/gateway/src/transport/source_history/file_lock.rs",
      ["source-history"],
    ],
    [
      "crates/spiffe-source/src/source_history_flow.rs",
      ["spiffe", "source-lifetime", "source-trust-selection", "source-history"],
    ],
    [
      "crates/transport-security/src/source_history_activation.rs",
      [
        "spiffe",
        "source-lifetime",
        "source-trust-selection",
        "spiffe-peer-domain",
        "source-history",
      ],
    ],
    ["spec/formal/source-trust-history/SourceTrustHistory.lean", []],
    ["docs/unrelated.md", []],
  ];
  const history = requirements.suites.find(
    (entry) => entry.id === "source-history",
  );
  assert.ok(history);
  for (const [path, expected] of cases) {
    const selected = requirements.suites.filter((entry) =>
      entry.implementation.includes(path),
    );
    assert.deepEqual(
      selected.map((entry) => entry.id),
      expected,
      path,
    );
    for (const reverted of [false, true]) {
      const f = fixture(t);
      seedRequiredSuite(f, history);
      for (const entry of selected)
        for (const proof of entry.proofs) f.write(proof, "proof\n");
      f.write(path, "before\n");
      const base = f.commit();
      f.write(path, "changed\n");
      f.commit();
      if (reverted) f.write(path, "before\n");
      const target = reverted ? f.commit() : f.git("rev-parse", "HEAD").trim();
      const result = f.run(f.tuple(target, base));
      assert.equal(result.status, 0, `${path}: ${result.stderr}`);
      assert.deepEqual(
        f.commands(),
        selected.map((entry) => `run ${entry.command[2]}`),
      );
    }
  }
});
