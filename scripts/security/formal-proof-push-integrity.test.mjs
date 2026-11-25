import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  fixture,
  installHook,
  push,
  registry,
} from "./formal-proof-push-gate.test.fixture.mjs";

const requirements = JSON.parse(
  readFileSync(
    new URL("../../spec/formal/proof-requirements.json", import.meta.url),
  ),
);

function seedRequiredSuite(f, suite, implementationPath) {
  f.pin(requirements);
  for (const name of [
    "formal-proof-manifest-set.mjs",
    "formal-proof-lock-history.mjs",
    "cargo-lock-projection.py",
    "cargo-workspace-projection.py",
    "cargo-workspace-multipackage.py",
  ])
    f.write(
      `scripts/security/${name}`,
      readFileSync(new URL(`./${name}`, import.meta.url)),
    );
  for (const name of ["proof-requirements.json", "proof-registry.json"])
    f.write(`spec/formal/${name}`, JSON.stringify(requirements));
  for (const proof of suite.proofs) f.write(proof, "proof\n");
  f.write(implementationPath, "original\n");
}

function lockIntegrityFixture(t) {
  const f = fixture(t);
  const policy = structuredClone(registry);
  policy.suites.push({
    id: "spiffe",
    implementation: ["src/spiffe"],
    lockProjection: { path: "Cargo.lock", root: "opensesame-spiffe-source" },
    proofs: ["spec/formal/spiffe/proof"],
    command: ["npm", "run", "verify:spiffe"],
  });
  f.pin(policy);
  for (const name of ["proof-registry.json", "proof-requirements.json"])
    f.write(`spec/formal/${name}`, JSON.stringify(policy));
  f.write("spec/formal/spiffe/proof", "proof\n");
  f.write("src/spiffe", "source\n");
  f.write(
    "Cargo.lock",
    `version = 4
[[package]]
name = "opensesame-spiffe-source"
version = "0.1.0"
dependencies = ["spiffe"]
[[package]]
name = "spiffe"
version = "0.19.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "${"a".repeat(64)}"
`,
  );
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

test("native push executes the verified helper even if its source changes afterward", (t) => {
  const { f } = lockIntegrityFixture(t);
  f.write(
    "Cargo.lock",
    readFileSync(join(f.repo, "Cargo.lock"), "utf8").replace(
      "a".repeat(64),
      "e".repeat(64),
    ),
  );
  f.commit();
  const lookup = spawnSync(
    "python3",
    ["-I", "-c", "import sys; print(sys.executable)"],
    { encoding: "utf8" },
  );
  assert.equal(lookup.status, 0, lookup.stderr);
  const python = lookup.stdout.trim();
  assert.match(python, /^\/[^\r\n\0]+$/u);
  const quotedPython = `'${python.replaceAll("'", "'\\''")}'`;
  const shim = join(f.bin, "python3");
  writeFileSync(
    shim,
    `#!/bin/sh\noriginal="$PWD/scripts/security/cargo-lock-projection.py"\nbackup="$original.race-backup"\ncp "$original" "$backup"\n: > "$0.race-observed"\nprintf '%s\\n' 'import json; print(json.dumps({"changed": False}))' > "$original"\n${quotedPython} "$@"\nresult=$?\ncat "$backup" > "$original"\nrm "$backup"\nexit "$result"\n`,
    { mode: 0o755 },
  );
  const result = push(f, "HEAD", "refs/heads/main");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(`${shim}.race-observed`), true);
  assert.deepEqual(f.commands(), ["run verify:spiffe"]);
  assert.equal(f.git("status", "--porcelain"), "");
});

test("a committed weakened lock selector cannot skip the mapped proof suites", (t) => {
  // A push changing a projection gate input together with Cargo.lock is
  // refused (#2668) before any projection output is trusted.
  const { f, base } = lockIntegrityFixture(t);
  f.write(
    "Cargo.lock",
    readFileSync(join(f.repo, "Cargo.lock"), "utf8").replace(
      "a".repeat(64),
      "e".repeat(64),
    ),
  );
  f.write(
    "scripts/security/formal-proof-lock-history.mjs",
    "export function lockAffectedSuites() { return new Set(); }\n",
  );
  f.commit();
  const head = f.git("rev-parse", "HEAD");
  const result = f.run(f.tuple(head, base));
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /lock-history\.mjs changed .*separately/u);
  assert.deepEqual(f.commands(), []);
});

test("every reviewed suite runs for its own implementation", (t) => {
  for (const suite of requirements.suites) {
    const f = fixture(t);
    const projected = new Set(
      requirements.suites.flatMap(
        (entry) => entry.manifestProjection?.manifests ?? [],
      ),
    );
    const path = suite.implementation.find(
      (entry) =>
        !projected.has(entry) &&
        entry !== "Cargo.toml" &&
        entry !== "Cargo.lock" &&
        !entry.endsWith("/build.rs"),
    );
    assert.ok(path, `${suite.id}: expected a direct implementation path`);
    seedRequiredSuite(f, suite, path);
    const selected = requirements.suites.filter((entry) =>
      entry.implementation.includes(path),
    );
    for (const entry of selected)
      for (const proof of entry.proofs) f.write(proof, "proof\n");
    const base = f.commit();
    f.write(path, "changed\n");
    const target = f.commit();
    const result = f.run(f.tuple(target, base));
    assert.equal(result.status, 0, `${suite.id}: ${result.stderr}`);
    assert.deepEqual(
      f.commands(),
      selected.map((entry) => `run ${entry.command[2]}`),
    );
  }
});

test("overlapping mapped suites run, but unrelated and Cargo helper edits skip", (t) => {
  const path = "crates/domain/src/lib.rs";
  const selected = requirements.suites.filter((entry) =>
    entry.implementation.includes(path),
  );
  assert.deepEqual(
    selected.map((entry) => entry.id),
    [
      "authority",
      "spiffe",
      "source-lifetime",
      "source-trust-selection",
      "spiffe-peer-domain",
      "nats-trust-rotation",
      "source-history",
    ],
  );
  for (const changed of [
    path,
    "docs/unrelated.md",
    "scripts/security/formal-cargo-isolation.py",
    "scripts/security/formal-cargo-freshness.py",
  ]) {
    const f = fixture(t);
    seedRequiredSuite(f, selected[0], selected[0].implementation[0]);
    for (const entry of selected)
      for (const proof of entry.proofs) f.write(proof, "proof\n");
    const base = f.commit();
    f.write(changed, "changed\n");
    const target = f.commit();
    const result = f.run(f.tuple(target, base));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      f.commands(),
      changed === path
        ? selected.map((entry) => `run ${entry.command[2]}`)
        : [],
    );
  }
});
