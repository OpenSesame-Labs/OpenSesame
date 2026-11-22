import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  fixture,
  installHook,
  push,
} from "./formal-proof-push-gate.test.fixture.mjs";

const rootPath = "crates/root/Cargo.toml";
const libPath = "crates/lib/Cargo.toml";
const futurePath = "crates/future/Cargo.toml";
const ancestorPath = "crates/Cargo.toml";
const buildPaths = [
  "crates/root/build.rs",
  "crates/lib/build.rs",
  "crates/future/build.rs",
];
const rootManifest = (future = false) => `[package]
name = "local-root"
version.workspace = true
[dependencies]
local-alias = { workspace = true }
${future ? 'future = { path = "../future", package = "local-future" }' : ""}
`;
const libManifest = `[package]
name = "local-lib"
version.workspace = true
edition.workspace = true
[dependencies]
serde = { workspace = true }
`;
const futureManifest = `[package]
name = "local-future"
version.workspace = true
`;
const workspaceManifest = (
  serde = 'features = ["derive"]',
  unused = "1",
) => `[workspace]
members = ["crates/root", "crates/lib"]
resolver = "2"
[workspace.package]
version = "0.1.0"
edition = "2021"
[workspace.dependencies]
local-alias = { package = "local-lib", path = "crates/lib" }
serde = { version = "1", ${serde} }
unused = "${unused}"
`;
const lock = (future = false, unrelated = "b") => `version = 4
[[package]]
name = "local-root"
version = "0.1.0"
dependencies = ["local-lib"${future ? ', "local-future"' : ""}]
[[package]]
name = "local-lib"
version = "0.1.0"
dependencies = ["serde"]
${future ? '[[package]]\nname = "local-future"\nversion = "0.1.0"\n' : ""}
[[package]]
name = "serde"
version = "1.0.0"
source = "registry+https://example.invalid/index"
checksum = "${"a".repeat(64)}"
[[package]]
name = "unrelated"
version = "1.0.0"
source = "registry+https://example.invalid/index"
checksum = "${unrelated.repeat(64)}"
`;

function initialize(t, future = false) {
  const f = fixture(t);
  const policy = {
    version: 1,
    suites: [
      {
        id: "a",
        implementation: [
          "src/a",
          rootPath,
          libPath,
          futurePath,
          ancestorPath,
          ...buildPaths,
        ],
        proofs: ["spec/formal/a/proof"],
        command: ["npm", "run", "verify:a"],
        lockProjection: { path: "Cargo.lock", root: "local-root" },
        manifestProjection: {
          path: "Cargo.toml",
          package: rootPath,
          lock: "Cargo.lock",
          root: "local-root",
          manifests: [rootPath, libPath, futurePath],
        },
      },
    ],
  };
  f.pin(policy);
  for (const path of [
    "spec/formal/proof-registry.json",
    "spec/formal/proof-requirements.json",
  ])
    f.write(path, JSON.stringify(policy));
  f.write("Cargo.toml", workspaceManifest());
  f.write("Cargo.lock", lock(future));
  f.write(rootPath, rootManifest(future));
  f.write(libPath, libManifest);
  if (future) f.write(futurePath, futureManifest);
  installHook(f);
  f.git(
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "-q",
    "origin",
    "HEAD:refs/heads/main",
  );
  return f;
}

function expectPush(f, selected) {
  const result = push(f, "HEAD", "refs/heads/main");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.commands(), selected ? ["run verify:a"] : []);
}

function rejectPush(f) {
  const result = push(f, "HEAD", "refs/heads/main");
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /projection|manifest/i);
  assert.deepEqual(f.commands(), []);
}

test("historical multi-package selection distinguishes relevant workspace inputs", (t) => {
  for (const [kind, content, selected] of [
    [
      "inherited dependency",
      workspaceManifest('features = ["derive", "rc"]'),
      true,
    ],
    [
      "unrelated dependency",
      workspaceManifest('features = ["derive"]', "2"),
      false,
    ],
  ]) {
    const f = initialize(t);
    f.write("Cargo.toml", content);
    f.commit();
    const result = push(f, "HEAD", "refs/heads/main");
    assert.equal(result.status, 0, `${kind}: ${result.stderr}`);
    assert.deepEqual(f.commands(), selected ? ["run verify:a"] : [], kind);
  }
  const f = initialize(t);
  f.write("Cargo.lock", lock(false, "c"));
  f.commit();
  expectPush(f, false);
});

test("local package additions, removals and a transient addition use each revision's manifests", (t) => {
  for (const kind of ["add", "remove", "revert"]) {
    const f = initialize(t, kind === "remove");
    const add = kind !== "remove";
    f.write(rootPath, rootManifest(add));
    f.write("Cargo.lock", lock(add));
    if (add) f.write(futurePath, futureManifest);
    else rmSync(join(f.repo, futurePath));
    f.commit();
    if (kind === "revert") {
      f.write(rootPath, rootManifest());
      f.write("Cargo.lock", lock());
      rmSync(join(f.repo, futurePath));
      f.commit();
    }
    expectPush(f, true);
  }
});

test("a transient relevant workspace change through a merge still selects the suite", (t) => {
  const f = initialize(t);
  const main = f.git("branch", "--show-current");
  f.git("checkout", "-qb", "side");
  f.write("Cargo.toml", workspaceManifest('features = ["derive", "rc"]'));
  f.commit();
  f.write("Cargo.toml", workspaceManifest());
  f.commit();
  f.git("checkout", "-q", main);
  f.write("src/other", "main branch\n");
  f.commit();
  f.git(
    "-c",
    "commit.gpgsign=false",
    "merge",
    "--no-ff",
    "-qm",
    "merge",
    "side",
  );
  expectPush(f, true);
});

test("a merge resolution compares the manifest sets of both advertised parents", (t) => {
  const f = initialize(t);
  const base = f.git("rev-parse", "HEAD");
  f.git("checkout", "-qb", "left", base);
  f.write("Cargo.toml", workspaceManifest('features = ["derive", "rc"]'));
  f.commit();
  f.git(
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "-q",
    "origin",
    "HEAD:refs/heads/left",
  );
  f.git("checkout", "-qb", "right", base);
  f.write("Cargo.toml", workspaceManifest('features = ["derive", "alloc"]'));
  f.commit();
  f.git(
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "-q",
    "origin",
    "HEAD:refs/heads/right",
  );
  const merge = spawnSync("git", ["merge", "--no-ff", "--no-commit", "left"], {
    cwd: f.repo,
    encoding: "utf8",
  });
  assert.notEqual(merge.status, 0);
  f.write(
    "Cargo.toml",
    workspaceManifest('features = ["derive", "alloc", "rc"]'),
  );
  f.git("add", "Cargo.toml");
  f.git("-c", "commit.gpgsign=false", "commit", "-qm", "resolve");
  const result = push(f, "HEAD", "refs/heads/combined");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.commands(), ["run verify:a"]);
});

test("missing, substituted, symlinked and transiently missing local manifests fail closed", (t) => {
  for (const kind of ["missing", "substituted", "symlink", "transient"]) {
    const f = initialize(t);
    if (kind === "substituted")
      f.write(
        "Cargo.toml",
        workspaceManifest().replace(
          'path = "crates/lib"',
          'path = "crates/other"',
        ),
      );
    else if (kind === "symlink") {
      rmSync(join(f.repo, "crates/lib"), { recursive: true });
      symlinkSync("elsewhere", join(f.repo, "crates/lib"));
    } else rmSync(join(f.repo, libPath));
    f.commit();
    if (kind === "transient") {
      f.write(libPath, libManifest);
      f.commit();
    }
    rejectPush(f);
  }
});

test("nested workspaces and alternate package.workspace roots fail closed", (t) => {
  for (const kind of ["ancestor", "ancestor-transient", "own", "explicit"]) {
    const f = initialize(t);
    if (kind.startsWith("ancestor")) f.write(ancestorPath, "[workspace]\n");
    if (kind === "own") f.write(libPath, `${libManifest}\n[workspace]\n`);
    if (kind === "explicit")
      f.write(
        libPath,
        libManifest.replace(
          "version.workspace = true",
          'version.workspace = true\nworkspace = "../other"',
        ),
      );
    f.commit();
    if (kind === "ancestor-transient") {
      rmSync(join(f.repo, ancestorPath));
      f.commit();
    }
    rejectPush(f);
  }
});

test("a narrowed lock projection cannot hide a different reachable dependency", (t) => {
  const f = initialize(t);
  const policyPath = "spec/formal/proof-registry.json";
  const policy = JSON.parse(readFileSync(join(f.repo, policyPath), "utf8"));
  policy.suites[0].lockProjection.dependency = "local-lib";
  f.pin(policy);
  for (const path of [policyPath, "spec/formal/proof-requirements.json"])
    f.write(path, JSON.stringify(policy));
  const withOther = (value) =>
    lock(false, value).replace(
      'dependencies = ["local-lib"]',
      'dependencies = ["local-lib", "unrelated"]',
    );
  f.write("Cargo.lock", withOther("b"));
  f.commit();
  f.git(
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "-q",
    "origin",
    "HEAD:refs/heads/main",
  );
  f.write("Cargo.lock", withOther("c"));
  f.commit();
  const result = push(f, "HEAD", "refs/heads/main");
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /Invalid formal proof suite/);
  assert.deepEqual(f.commands(), []);
});

test("an unrelated path or proof-only commit skips the suite", (t) => {
  for (const path of ["src/other", "spec/formal/a/proof"]) {
    const f = initialize(t);
    f.write(path, "changed\n");
    f.commit();
    expectPush(f, false);
  }
});
