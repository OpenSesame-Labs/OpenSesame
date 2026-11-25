import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  fixture,
  installHook,
  push,
  registry,
} from "./formal-proof-push-gate.test.fixture.mjs";

const source = "registry+https://github.com/rust-lang/crates.io-index";
const hash = (character) => character.repeat(64);
const lock = ({
  sdk = "a",
  direct = "b",
  unrelated = "c",
  shuttle = "1",
  extra = "",
  root = true,
} = {}) => `version = 4
${
  root
    ? `[[package]]
name = "opensesame-spiffe-source"
version = "0.1.0"
dependencies = ["spiffe", "direct", "domain"]`
    : ""
}
[[package]]
name = "domain"
version = "1.0.0"
dependencies = ["shuttle"]
[[package]]
name = "shuttle"
version = "1.0.0"
source = "${source}"
checksum = "${hash(shuttle)}"
[[package]]
name = "spiffe"
version = "0.19.0"
source = "${source}"
checksum = "${hash(sdk)}"
dependencies = ["transitive"]
[[package]]
name = "direct"
version = "1.0.0"
source = "${source}"
checksum = "${hash(direct)}"
[[package]]
name = "transitive"
version = "1.0.0"
source = "${source}"
checksum = "${hash("d")}"
[[package]]
name = "unrelated"
version = "1.0.0"
source = "${source}"
checksum = "${hash(unrelated)}"
${extra}`;

function initialize(t, initial = lock()) {
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
  f.write("spec/formal/proof-registry.json", JSON.stringify(policy));
  f.write("spec/formal/proof-requirements.json", JSON.stringify(policy));
  f.write("spec/formal/spiffe/proof", "proof\n");
  f.write("src/spiffe", "source\n");
  f.write("Cargo.lock", initial);
  installHook(f);
  f.git(
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "-q",
    "origin",
    "HEAD:refs/heads/main",
  );
  return { f, policy, base: f.git("rev-parse", "HEAD") };
}

function expectPush(f, expected) {
  const result = push(f, "HEAD", "refs/heads/main");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.commands(), expected ? ["run verify:spiffe"] : []);
}

function writePolicy(f, policy) {
  for (const name of ["proof-registry.json", "proof-requirements.json"])
    f.write(`spec/formal/${name}`, JSON.stringify(policy));
}

test("native push selects only mapped paths and reachable lock changes", (t) => {
  for (const [kind, contents, selected] of [
    ["unrelated", lock({ unrelated: "e" }), false],
    ["format", `${lock()}\n# comment only\n`, false],
    ["sdk", lock({ sdk: "e" }), true],
    ["other direct dependency", lock({ direct: "e" }), true],
    // Lockfiles do not encode whether this transitive dev/optional package is active.
    ["inactive optional package", lock({ shuttle: "e" }), true],
    ["transitive", lock().replace(hash("d"), hash("e")), true],
    [
      "edge",
      lock().replace(
        'dependencies = ["transitive"]',
        'dependencies = ["transitive", "direct"]',
      ),
      true,
    ],
  ]) {
    const { f } = initialize(t);
    f.write("Cargo.lock", contents);
    f.commit();
    const result = push(f, "HEAD", "refs/heads/main");
    assert.equal(result.status, 0, `${kind}: ${result.stderr}`);
    assert.deepEqual(f.commands(), selected ? ["run verify:spiffe"] : [], kind);
  }
  const { f } = initialize(t);
  f.write("src/spiffe", "implementation changed\n");
  f.commit();
  expectPush(f, true);
});

test("a changed closure later reverted in pushed history still selects the suite", (t) => {
  const { f } = initialize(t);
  f.write("Cargo.lock", lock({ sdk: "e" }));
  f.commit();
  f.write("Cargo.lock", lock());
  f.commit();
  expectPush(f, true);
});

test("a new policy and root require runner metadata first", (t) => {
  const f = fixture(t);
  f.write("Cargo.lock", lock({ root: false }));
  installHook(f);
  f.git(
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "-q",
    "origin",
    "HEAD:refs/heads/main",
  );
  const policy = structuredClone(registry);
  policy.suites.push({
    id: "spiffe",
    implementation: ["src/spiffe"],
    lockProjection: { path: "Cargo.lock", root: "opensesame-spiffe-source" },
    proofs: ["spec/formal/spiffe/proof"],
    command: ["npm", "run", "verify:spiffe"],
  });
  f.pin(policy);
  writePolicy(f, policy);
  f.write("spec/formal/spiffe/proof", "proof\n");
  f.write("Cargo.lock", lock());
  f.commit();
  const result = push(f, "HEAD", "refs/heads/main");
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /formal runner .*missing/i);
  assert.deepEqual(f.commands(), []);
});

test("removing a root selects the suite; absence in both revisions does not", (t) => {
  const removed = initialize(t);
  removed.f.write("Cargo.lock", lock({ root: false }));
  removed.f.commit();
  expectPush(removed.f, true);

  const absent = initialize(t, lock({ root: false }));
  absent.f.write("Cargo.lock", lock({ root: false, unrelated: "e" }));
  absent.f.commit();
  expectPush(absent.f, false);
});

test("a transiently introduced root remains selected after it is removed", (t) => {
  const { f } = initialize(t, lock({ root: false }));
  f.write("Cargo.lock", lock());
  f.commit();
  f.write("Cargo.lock", lock({ root: false }));
  f.commit();
  expectPush(f, true);
});

test("a force push to an ancestor compares the old destination to the target", (t) => {
  const { f, base } = initialize(t);
  f.write("Cargo.lock", lock({ sdk: "e" }));
  f.commit();
  f.git(
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "-q",
    "origin",
    "HEAD:refs/heads/main",
  );
  f.git("checkout", "-q", "--detach", base);
  const result = f.run(f.tuple(base, f.git("rev-parse", "origin/main")));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.commands(), ["run verify:spiffe"]);
});

test("a merged dependency already at the destination does not reselect the suite", (t) => {
  const { f } = initialize(t);
  const branch = f.git("symbolic-ref", "--short", "HEAD");
  f.git("checkout", "-qb", "topic");
  f.write("src/other", "topic\n");
  f.commit();
  f.git("checkout", "-q", branch);
  f.write("Cargo.lock", lock({ sdk: "e" }));
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
  f.git("merge", "--no-ff", "-qm", "merge destination", branch);
  expectPush(f, false);
});

test("a merge resolution with a new closure selects the suite even when parents are remote", (t) => {
  const { f } = initialize(t);
  const branch = f.git("symbolic-ref", "--short", "HEAD");
  f.git("checkout", "-qb", "topic");
  f.write("Cargo.lock", lock({ sdk: "e" }));
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
  f.write("Cargo.lock", lock({ direct: "f" }));
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
  const merged = spawnSync("git", ["merge", "--no-ff", "--no-commit", branch], {
    cwd: f.repo,
    encoding: "utf8",
  });
  assert.ok([0, 1].includes(merged.status));
  f.write("Cargo.lock", lock({ sdk: "e", direct: "f" }));
  f.git("add", "Cargo.lock");
  f.git("-c", "commit.gpgsign=false", "commit", "-qm", "resolve lock");
  const result = push(f, "HEAD", "refs/heads/merged");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.commands(), ["run verify:spiffe"]);
});

test("merge resolution equal to one parent's closure ignores unrelated lock differences", (t) => {
  const { f } = initialize(t);
  const branch = f.git("symbolic-ref", "--short", "HEAD");
  f.git("checkout", "-qb", "topic");
  f.write("Cargo.lock", lock({ sdk: "e", unrelated: "f" }));
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
  f.write("Cargo.lock", lock({ unrelated: "1" }));
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
  const merged = spawnSync("git", ["merge", "--no-ff", "--no-commit", branch], {
    cwd: f.repo,
    encoding: "utf8",
  });
  // Depending on Git's hunk choices, the merge may be clean or conflict.
  assert.ok([0, 1].includes(merged.status));
  f.write("Cargo.lock", lock({ sdk: "e", unrelated: "2" }));
  f.git("add", "Cargo.lock");
  f.git(
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "resolve unrelated lock",
  );
  const result = push(f, "HEAD", "refs/heads/merged");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.commands(), []);
});

test("removal or transient weakening of the lock selector fails closed", (t) => {
  for (const transient of [false, true]) {
    const { f, policy } = initialize(t);
    const altered = structuredClone(policy);
    delete altered.suites.find((suite) => suite.id === "spiffe").lockProjection;
    writePolicy(f, altered);
    f.commit();
    f.write("Cargo.lock", lock({ sdk: "e" }));
    f.commit();
    if (transient) {
      writePolicy(f, policy);
      f.commit();
    }
    const result = push(f, "HEAD", "refs/heads/main");
    assert.notEqual(result.status, 0, `transient=${transient}`);
    assert.match(result.stderr, /mapping|proof contract/i);
    assert.deepEqual(f.commands(), []);
  }
});

test("bad lock input, missing helper, and dishonest Python output cannot skip proof", (t) => {
  for (const kind of [
    "invalid",
    "missing-lock",
    "dirty-helper",
    "missing-python",
    "bad-output",
  ]) {
    const { f } = initialize(t);
    if (kind === "invalid") f.write("Cargo.lock", "invalid = [\n");
    else if (kind === "missing-lock") rmSync(join(f.repo, "Cargo.lock"));
    else f.write("Cargo.lock", lock({ sdk: "e" }));
    f.commit();
    if (kind === "dirty-helper")
      f.write(
        "scripts/security/cargo-lock-projection.py",
        'print("{\\"changed\\":false}")\n',
      );
    if (kind === "missing-python" || kind === "bad-output") {
      const shim = join(f.bin, "python3");
      writeFileSync(
        shim,
        kind === "missing-python"
          ? "#!/bin/sh\nexit 127\n"
          : '#!/bin/sh\necho \'{"changed":"false"}\'\n',
      );
      chmodSync(shim, 0o755);
    }
    const result = push(f, "HEAD", "refs/heads/main");
    assert.notEqual(result.status, 0, kind);
    assert.match(result.stderr, /lock projection|clean worktree/i, kind);
    assert.deepEqual(f.commands(), []);
  }
});

test("a committed weakened lock helper cannot skip the mapped proof suites", (t) => {
  const { f } = initialize(t);
  f.write("Cargo.lock", lock({ sdk: "e" }));
  f.write(
    "scripts/security/cargo-lock-projection.py",
    'print("{\\"changed\\":false}")\n',
  );
  f.commit();
  const result = push(f, "HEAD", "refs/heads/main");
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /projection\.py changed .*separately/u);
  assert.deepEqual(f.commands(), []);
});
