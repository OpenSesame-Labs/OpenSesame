import assert from "node:assert/strict";
import { readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  fixture,
  installHook,
  push,
} from "./formal-proof-push-gate.test.fixture.mjs";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const registry = JSON.parse(read("spec/formal/proof-registry.json"));
const authority = registry.suites.find((suite) => suite.id === "authority");

function initialize(t) {
  const f = fixture(t);
  const policy = { version: 1, suites: [authority] };
  f.pin(policy);
  for (const name of ["proof-registry.json", "proof-requirements.json"])
    f.write(`spec/formal/${name}`, JSON.stringify(policy));
  for (const proof of authority.proofs) f.write(proof, "proof\n");
  for (const path of [
    "Cargo.toml",
    "Cargo.lock",
    "crates/domain/Cargo.toml",
    "crates/domain/src/lib.rs",
  ])
    f.write(path, read(path));
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

function replaceOnce(value, before, after) {
  assert.equal(
    value.split(before).length,
    2,
    `expected one occurrence of ${before}`,
  );
  return value.replace(before, after);
}

function expectPush(f, selected) {
  const result = push(f, "HEAD", "refs/heads/main");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    f.commands(),
    selected ? ["run verify:authority-formal"] : [],
  );
}

function checksumChanged(lock, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(\\[\\[package\\]\\]\\nname = "${escaped}"\\nversion = "[^"]+"\\nsource = "[^"]+"\\nchecksum = ")[a-f0-9]{64}("\\n)`,
  );
  assert.match(lock, pattern);
  return lock.replace(pattern, `$1${"f".repeat(64)}$2`);
}

test("authority native pushes select only relevant manifest and lock inputs", (t) => {
  for (const [kind, path, change, selected] of [
    [
      "crate manifest",
      "crates/domain/Cargo.toml",
      (s) => `${s}\n# reviewed crate change\n`,
      true,
    ],
    [
      "crate root module wiring",
      "crates/domain/src/lib.rs",
      (s) =>
        replaceOnce(
          s,
          "pub mod grant;",
          '#[path = "alternate_grant.rs"]\npub mod grant;',
        ),
      true,
    ],
    [
      "implicit build script",
      "crates/domain/build.rs",
      () => "fn main() {}\n",
      true,
    ],
    [
      "inherited feature",
      "Cargo.toml",
      (s) =>
        replaceOnce(
          s,
          'serde = { version = "1.0.219", features = ["derive"] }',
          'serde = { version = "1.0.219", features = ["derive", "rc"] }',
        ),
      true,
    ],
    [
      "unrelated dependency",
      "Cargo.toml",
      (s) => replaceOnce(s, 'async-nats = "0.52.0"', 'async-nats = "0.53.0"'),
      false,
    ],
    [
      "unrelated member",
      "Cargo.toml",
      (s) =>
        replaceOnce(
          s,
          '  "crates/domain",',
          '  "crates/domain",\n  "crates/unrelated",',
        ),
      false,
    ],
    [
      "reachable profile",
      "Cargo.toml",
      (s) =>
        replaceOnce(
          s,
          "[profile.dev.package.sha2]\nopt-level = 3",
          "[profile.dev.package.sha2]\nopt-level = 2",
        ),
      true,
    ],
    [
      "unrelated profile",
      "Cargo.toml",
      (s) =>
        replaceOnce(
          s,
          "[profile.dev.package.opensesame-human-vault]\nopt-level = 3",
          "[profile.dev.package.opensesame-human-vault]\nopt-level = 2",
        ),
      false,
    ],
    ["reachable lock", "Cargo.lock", (s) => checksumChanged(s, "serde"), true],
    [
      "unrelated lock",
      "Cargo.lock",
      (s) => checksumChanged(s, "async-nats"),
      false,
    ],
  ]) {
    const f = initialize(t);
    f.write(path, change(path === "crates/domain/build.rs" ? "" : read(path)));
    f.commit();
    const result = push(f, "HEAD", "refs/heads/main");
    assert.equal(result.status, 0, `${kind}: ${result.stderr}`);
    assert.deepEqual(
      f.commands(),
      selected ? ["run verify:authority-formal"] : [],
      kind,
    );
  }
});

test("transient relevant workspace changes select authority", (t) => {
  const f = initialize(t);
  const original = read("Cargo.toml");
  f.write(
    "Cargo.toml",
    replaceOnce(
      original,
      'serde = { version = "1.0.219", features = ["derive"] }',
      'serde = { version = "1.0.219", features = ["derive", "rc"] }',
    ),
  );
  f.commit();
  f.write("Cargo.toml", original);
  f.commit();
  expectPush(f, true);
});

test("a restored workspace input on a merged side branch selects authority", (t) => {
  const f = initialize(t);
  const main = f.git("branch", "--show-current");
  f.git("checkout", "-qb", "side");
  const original = read("Cargo.toml");
  f.write(
    "Cargo.toml",
    replaceOnce(
      original,
      'serde = { version = "1.0.219", features = ["derive"] }',
      'serde = { version = "1.0.219", features = ["derive", "rc"] }',
    ),
  );
  f.commit();
  f.write("Cargo.toml", original);
  f.commit();
  f.git("checkout", "-q", main);
  f.write("src/other", "merge\n");
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

test("malformed or non-regular workspace inputs fail closed", (t) => {
  for (const kind of [
    "toml",
    "missing-key",
    "missing-package",
    "symlink-package",
    "bad-lock",
  ]) {
    const f = initialize(t);
    let workspace = read("Cargo.toml");
    if (kind === "toml") workspace += "\ninvalid = [\n";
    if (kind === "missing-key")
      workspace = replaceOnce(
        workspace,
        'serde = { version = "1.0.219", features = ["derive"] }\n',
        "",
      );
    if (kind === "missing-package")
      rmSync(join(f.repo, "crates/domain/Cargo.toml"));
    if (kind === "symlink-package") {
      rmSync(join(f.repo, "crates/domain/Cargo.toml"));
      symlinkSync("../../Cargo.toml", join(f.repo, "crates/domain/Cargo.toml"));
    }
    if (kind === "bad-lock") f.write("Cargo.lock", "version = [\n");
    f.write("Cargo.toml", `${workspace}\n# select manifest input\n`);
    f.commit();
    const result = push(f, "HEAD", "refs/heads/main");
    assert.notEqual(result.status, 0, kind);
    assert.match(result.stderr, /projection/i, kind);
    assert.deepEqual(f.commands(), []);
  }
});

test("unrelated and proof-only changes skip authority", (t) => {
  for (const path of ["src/other", "spec/formal/authority/Authority.lean"]) {
    const f = initialize(t);
    f.write(path, "updated\n");
    f.commit();
    expectPush(f, false);
  }
});
