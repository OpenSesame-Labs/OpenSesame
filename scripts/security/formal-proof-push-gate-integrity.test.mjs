import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  fixture,
  installHook,
  nil,
  productionFixture,
  push,
} from "./formal-proof-push-gate.test.fixture.mjs";
import { pushDestination } from "./formal-proof-remote-main.mjs";
import {
  RUNNER_INVENTORY_PATH,
  loadRunnerInventory,
} from "./formal-proof-runner-pins.mjs";

test("an exact destination that names a remote fails closed", () => {
  const git = (_root, args) => {
    assert.deepEqual(args, ["remote"]);
    return Buffer.from("origin\n");
  };
  assert.throws(
    () => pushDestination("/unused", "origin", git, true),
    /ambiguous push destination/i,
  );
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
  const target = f.commit();
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
  rmSync(f.log, { force: true });
  const direct = f.run(f.tuple(target, nil, "refs/heads/new"), {
    FORMAL_TEST_STATUS: "9",
  });
  assert.notEqual(direct.status, 0);
  assert.match(direct.stderr, /suite a failed/);
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
  f.git("remote", "set-url", "--add", "--push", "origin", f.remote);
  const ambiguous = f.run(f.tuple(target, nil, "refs/heads/new"));
  assert.notEqual(ambiguous.status, 0);
  assert.match(ambiguous.stderr, /multiple push destinations/i);
});

test("unchanged tracked Cargo metadata permits a mapped implementation push", (t) => {
  const f = productionFixture(t, "authority", (fixture) => {
    fixture.write(".cargo/config.toml", "[net]\noffline=true\n");
    fixture.write("spec/formal/authority/build.rs", "fn main() {}\n");
  });
  f.write("src/a", "changed\n");
  f.commit();
  const result = push(f, "HEAD", "refs/heads/main");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.commands(), ["run verify:authority-formal"]);
});

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

test("inventory loading uses the committed blob across dirty and restored races", (t) => {
  const trusted = readFileSync(
    new URL("./formal-proof-runner-pins.json", import.meta.url),
  );
  const altered = Buffer.from("[]");
  const oid = "a".repeat(40);
  for (const mode of [
    "restore-before-check",
    "alter-before-check",
    "alter-after-check",
    "grow-during-read",
    "oversized",
    "malformed-size",
    "mismatched-blob",
  ]) {
    const root = mkdtempSync(join(tmpdir(), "formal-inventory-race-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, RUNNER_INVENTORY_PATH);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, mode === "restore-before-check" ? altered : trusted);
    let blobRead = false;
    const git = (_root, args) => {
      if (args[0] === "ls-tree")
        return Buffer.from(`100644 blob ${oid}\t${RUNNER_INVENTORY_PATH}\0`);
      if (args[0] === "cat-file" && args[1] === "-s") {
        if (mode === "oversized") return Buffer.from("262145\n");
        if (mode === "malformed-size") return Buffer.from("12junk\n");
        return Buffer.from(
          `${trusted.length + (mode === "mismatched-blob" ? 1 : 0)}\n`,
        );
      }
      if (args[0] === "cat-file" && args[1] === "blob") {
        blobRead = true;
        if (mode === "restore-before-check") writeFileSync(path, trusted);
        if (mode === "alter-before-check") writeFileSync(path, altered);
        return Buffer.from(trusted);
      }
      throw new Error("unexpected Git command");
    };
    if (["oversized", "malformed-size", "mismatched-blob"].includes(mode)) {
      assert.throws(() => loadRunnerInventory(root, oid, git), /size/i);
      assert.equal(blobRead, mode === "mismatched-blob");
      continue;
    }
    if (mode === "alter-before-check") {
      assert.throws(
        () => loadRunnerInventory(root, oid, git),
        /differs from committed HEAD/i,
      );
      continue;
    }
    if (mode === "grow-during-read") {
      const originalRead = fs.readSync;
      let injected = false;
      fs.readSync = (...args) => {
        const count = originalRead(...args);
        if (!injected) {
          injected = true;
          fs.appendFileSync(path, "x");
        }
        return count;
      };
      syncBuiltinESMExports();
      try {
        assert.throws(
          () => loadRunnerInventory(root, oid, git),
          /differs from committed HEAD/i,
        );
      } finally {
        fs.readSync = originalRead;
        syncBuiltinESMExports();
      }
      continue;
    }
    const original = Buffer.prototype.equals;
    if (mode === "alter-after-check")
      Buffer.prototype.equals = function (other) {
        const equal = original.call(this, other);
        if (equal) writeFileSync(path, altered);
        return equal;
      };
    let inventory;
    try {
      inventory = loadRunnerInventory(root, oid, git);
    } finally {
      Buffer.prototype.equals = original;
    }
    assert.equal(inventory.suites.auth.script, "verify:auth-formal");
    if (mode === "alter-after-check")
      assert.deepEqual(readFileSync(path), altered);
  }
});

test("production inventories protect new proof execution metadata", (t) => {
  for (const [id, path] of [
    ["oauth", "spec/formal/oauth/check-hosted-flow-report.mjs"],
    ["source-lifetime", "scripts/security/formal-cargo-isolation.py"],
    [
      "source-trust-selection",
      "spec/formal/source-trust-selection/check-drift.py",
    ],
    ["spiffe-peer-domain", "scripts/security/cargo-workspace-multipackage.py"],
    ["nats-trust-rotation", "scripts/mtls/mtls-fixtures.sh"],
    ["nats-trust-rotation", "ops/nats/local-dev.conf"],
    ["source-history", "spec/formal/source-trust-history/check-drift.py"],
    [
      "source-history",
      "spec/formal/source-trust-history/required-theorems.lean",
    ],
    ["source-history", "scripts/security/formal-proof-source-history.mjs"],
  ]) {
    const f = productionFixture(t, id);
    f.write("src/a", "changed\n");
    f.write(path, "changed execution metadata\n");
    f.commit();
    const result = push(f, "HEAD", "refs/heads/main");
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /formal runner .*changed/i);
    assert.deepEqual(f.commands(), []);
  }
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
