import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fixture, registry } from "./formal-proof-push-gate.test.fixture.mjs";

const requirements = JSON.parse(
  readFileSync(
    new URL("../../spec/formal/proof-requirements.json", import.meta.url),
  ),
);
const manifest = "spec/formal/proof-requirements.json";
const registryPath = "spec/formal/proof-registry.json";

function seedRequiredSuite(f, suite) {
  f.pin(requirements);
  f.write(manifest, JSON.stringify(requirements));
  f.write(registryPath, JSON.stringify(requirements));
  for (const required of requirements.suites)
    for (const proof of required.proofs) f.write(proof, "proof\n");
  f.write(suite.implementation[0], "original\n");
}

test("every reviewed suite runs for its own implementation", (t) => {
  for (const suite of requirements.suites) {
    const f = fixture(t);
    seedRequiredSuite(f, suite);
    const base = f.commit();
    f.write(suite.implementation[0], "changed\n");
    const target = f.commit();
    const result = f.run(f.tuple(target, base));
    assert.equal(result.status, 0, `${suite.id}: ${result.stderr}`);
    assert.deepEqual(
      f.commands(),
      requirements.suites
        .filter((required) =>
          required.implementation.includes(suite.implementation[0]),
        )
        .map((required) => `run ${required.command[2]}`),
    );
  }
});

test("overlapping authority, SPIFFE, and lifetime mappings all run, but an unrelated edit skips", (t) => {
  const path = "crates/domain/Cargo.toml";
  const selected = requirements.suites.filter((entry) =>
    entry.implementation.includes(path),
  );
  assert.deepEqual(
    selected.map((entry) => entry.id),
    ["authority", "spiffe", "source-lifetime"],
  );
  for (const changed of [path, "docs/unrelated.md"]) {
    const f = fixture(t);
    seedRequiredSuite(f, selected[0]);
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


test("signing implementation changes select the lifetime proof without selecting proof-only edits", (t) => {
  const suite = requirements.suites.find(
    (entry) => entry.id === "source-lifetime",
  );
  const implementation = [
    "crates/transport-security/src/client.rs",
    "crates/transport-security/src/server.rs",
    "crates/transport-security/src/signing_fence.rs",
  ];
  for (const path of implementation)
    assert.ok(suite.implementation.includes(path));
  for (const changed of [
    ...implementation,
    suite.proofs[0],
    "docs/unrelated.md",
  ]) {
    const f = fixture(t);
    seedRequiredSuite(f, suite);
    const base = f.commit();
    f.write(changed, "changed\n");
    const target = f.commit();
    const result = f.run(f.tuple(target, base));
    assert.equal(result.status, 0, `${changed}: ${result.stderr}`);
    assert.deepEqual(
      f.commands(),
      implementation.includes(changed) ? [`run ${suite.command[2]}`] : [],
    );
  }
});


test("a historical base may predate a newly registered suite", (t) => {
  const f = fixture(t);
  const suite = requirements.suites.find((entry) => entry.id === "oauth");
  seedRequiredSuite(f, suite);
  const target = f.commit();
  const result = f.run(f.tuple(target, f.base));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.commands(), ["run verify:oauth-formal"]);
});

test("registry changes cannot add unpinned or remove required coverage", (t) => {
  for (const kind of [
    "missing-path",
    "extra-path",
    "extra-proof",
    "missing-suite",
    "extra-suite",
  ]) {
    const f = fixture(t);
    seedRequiredSuite(f, requirements.suites[0]);
    const base = f.commit();
    const changed = structuredClone(requirements);
    const oauth = changed.suites.find((entry) => entry.id === "oauth");
    if (kind === "missing-path") oauth.implementation.shift();
    if (kind === "extra-path") oauth.implementation.push("src/extra");
    if (kind === "extra-proof") oauth.proofs.push("spec/formal/extra.lean");
    if (kind === "missing-suite")
      changed.suites = changed.suites.filter((entry) => entry.id !== "oauth");
    if (kind === "extra-suite") changed.suites.push(registry.suites[0]);
    f.write(registryPath, JSON.stringify(changed));
    const target = f.commit();
    const result = f.run(f.tuple(target, base));
    assert.notEqual(result.status, 0, kind);
    assert.match(result.stderr, /required|unpinned/i);
    assert.deepEqual(f.commands(), []);
  }
});

test("a previously weakened registry cannot hide a required source change", (t) => {
  for (const kind of ["mapping", "suite"]) {
    const f = fixture(t);
    const suite = requirements.suites.find((entry) => entry.id === "oauth");
    seedRequiredSuite(f, suite);
    f.commit();
    const weakened = structuredClone(requirements);
    if (kind === "mapping")
      weakened.suites
        .find((entry) => entry.id === "oauth")
        .implementation.shift();
    else
      weakened.suites = weakened.suites.filter((entry) => entry.id !== "oauth");
    f.write(registryPath, JSON.stringify(weakened));
    const previous = f.commit(); // Simulate an already-remote invalid policy.
    f.write(suite.implementation[0], "changed\n");
    const target = f.commit();
    const result = f.run(f.tuple(target, previous));
    assert.notEqual(result.status, 0, kind);
    assert.match(result.stderr, /required|mapping/i);
    assert.deepEqual(f.commands(), []);
  }
});

test("consistent metadata-only changes are read from a historical commit without running code", (t) => {
  const f = fixture(t);
  const changed = structuredClone(registry);
  changed.suites[0].implementation.push("src/other");
  f.pin(changed);
  f.write(registryPath, JSON.stringify(changed));
  f.write(manifest, JSON.stringify(changed));
  const target = f.commit();
  f.write("src/other", "later checkout only\n");
  f.commit();
  f.write(manifest, "dirty, never imported");
  const result = f.run(f.tuple(target));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.commands(), []);
});

test("the trusted minimum selects a path removed from both previously pushed JSON files", (t) => {
  const f = fixture(t);
  const weakened = structuredClone(registry);
  weakened.suites[0].implementation = weakened.suites[0].implementation.filter(
    (path) => path !== "src/a",
  );
  f.write(registryPath, JSON.stringify(weakened));
  f.write(manifest, JSON.stringify(weakened));
  const previous = f.commit(); // Simulate an earlier unreviewed policy push.
  f.write("src/a", "changed despite removed mapping\n");
  const target = f.commit();
  const result = f.run(f.tuple(target, previous));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match required mappings/);
  assert.deepEqual(f.commands(), []);
});

test("a policy-aware worktree rejects metadata changes to a manifest-less historical target", (t) => {
  const f = fixture(t);
  const branch = f.git("symbolic-ref", "--short", "HEAD");
  f.git("checkout", "-qb", "legacy");
  rmSync(join(f.repo, manifest));
  const previous = f.commit();
  const old = structuredClone(registry);
  old.suites[0].implementation.push("src/other");
  f.write(registryPath, JSON.stringify(old));
  const target = f.commit();
  f.git("checkout", "-q", branch);
  const result = f.run(f.tuple(target, previous, "refs/heads/legacy"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requirements are missing/);
  assert.deepEqual(f.commands(), []);
});

test("a metadata change cannot remove requirements from the target", (t) => {
  const f = fixture(t);
  rmSync(join(f.repo, manifest));
  const target = f.commit();
  const result = f.run(f.tuple(target));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requirements are missing/);
  assert.deepEqual(f.commands(), []);
});

test("registry history before first requirements introduction can migrate", (t) => {
  for (const changedSource of [false, true]) {
    const f = fixture(t);
    f.git("checkout", "-q", "--orphan", "legacy");
    rmSync(join(f.repo, registryPath));
    rmSync(join(f.repo, manifest));
    const base = f.commit();
    f.write(registryPath, JSON.stringify(registry));
    f.commit();
    if (changedSource) {
      f.write("src/a", "migrated change\n");
      f.commit();
    }
    f.write(manifest, JSON.stringify(registry));
    const target = f.commit();
    const result = f.run(f.tuple(target, base));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(f.commands(), changedSource ? ["run verify:a"] : []);
  }
});

test("legacy mappings still bind changes made before requirements were introduced", (t) => {
  const f = fixture(t);
  f.git("checkout", "-q", "--orphan", "legacy");
  rmSync(join(f.repo, registryPath));
  rmSync(join(f.repo, manifest));
  const base = f.commit();
  const extended = structuredClone(registry);
  extended.suites[0].implementation.push("src/other");
  f.write(registryPath, JSON.stringify(extended));
  f.commit();
  f.write("src/other", "legacy implementation\n");
  f.commit();
  f.write(registryPath, JSON.stringify(registry));
  f.write(manifest, JSON.stringify(registry));
  const target = f.commit();
  const result = f.run(f.tuple(target, base));
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /removes required formal proof mapping a: src\/other/,
  );
  assert.deepEqual(f.commands(), []);
});

test("requirements cannot disappear in history and later be restored", (t) => {
  const f = fixture(t);
  rmSync(join(f.repo, manifest));
  f.commit();
  f.write(manifest, JSON.stringify(registry));
  const target = f.commit();
  const result = f.run(f.tuple(target));
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /requirements are missing from policy-changing commit/,
  );
  assert.deepEqual(f.commands(), []);
});

test("historical requirements are parsed as data, never executed", (t) => {
  const f = fixture(t);
  const marker = join(f.dir, "executed");
  f.write(
    manifest,
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed");`,
  );
  f.commit();
  f.write(manifest, JSON.stringify(registry));
  const target = f.commit();
  const result = f.run(f.tuple(target));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid formal proof requirements/);
  assert.equal(existsSync(marker), false);
  assert.deepEqual(f.commands(), []);
});
