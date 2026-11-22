import assert from "node:assert/strict";
import { readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  fixture,
  installHook,
  productionFixture,
  push,
  registry,
} from "./formal-proof-push-gate.test.fixture.mjs";
import {
  parseRunnerInventory,
  validateRunnerMinimums,
} from "./formal-proof-runner-pins.mjs";

const { suites: PINNED_FORMAL_RUNNERS, shared: SHARED_FORMAL_RUNNERS } =
  parseRunnerInventory(
    readFileSync(new URL("./formal-proof-runner-pins.json", import.meta.url)),
  );

test("every registered suite has an existing, matching runner inventory", () => {
  const root = new URL("../../", import.meta.url);
  const registered = JSON.parse(
    readFileSync(new URL("spec/formal/proof-registry.json", root), "utf8"),
  );
  assert.deepEqual(
    Object.keys(PINNED_FORMAL_RUNNERS).sort(),
    registered.suites.map((suite) => suite.id).sort(),
  );
  for (const suite of registered.suites) {
    const runner = PINNED_FORMAL_RUNNERS[suite.id];
    assert.equal(runner.script, suite.command[2]);
    assert.ok(runner.files.length);
    for (const path of runner.files)
      assert.ok(readFileSync(new URL(path, root)));
  }
  for (const path of SHARED_FORMAL_RUNNERS)
    assert.ok(readFileSync(new URL(path, root)));
  assert.throws(() => parseRunnerInventory(Buffer.from("{}")), /inventory/i);
  const stripped = registered.suites.map((suite) => ({
    ...suite,
    proofs: suite.proofs.filter(
      (path) => !path.endsWith("/required-theorems.lean"),
    ),
  }));
  assert.throws(
    () =>
      validateRunnerMinimums(
        { shared: SHARED_FORMAL_RUNNERS, suites: PINNED_FORMAL_RUNNERS },
        stripped,
      ),
    /minimum/i,
  );
});

function changeScript(f, name, value) {
  const doc = JSON.parse(readFileSync(join(f.repo, "package.json"), "utf8"));
  doc.scripts[name] = value;
  f.write("package.json", JSON.stringify(doc));
}

function reject(result, pattern = /formal runner/i) {
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, pattern);
}

function advertise(f, branch) {
  f.git(
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "-q",
    "origin",
    `HEAD:refs/heads/${branch}`,
  );
}

test("rejects selected npm script and lifecycle tampering in a native push", (t) => {
  for (const script of ["verify:a", "preverify:a", "postverify:a"]) {
    const f = fixture(t);
    installHook(f);
    f.write("src/a", "changed\n");
    changeScript(f, script, "true");
    f.commit();
    reject(
      push(f, "HEAD", "refs/heads/main"),
      /formal runner npm script verify:a changed/i,
    );
    assert.deepEqual(f.commands(), []);
  }
});

test("production runner inventory blocks npm script-shell tampering", (t) => {
  for (const tamper of [false, true]) {
    const f = productionFixture(t, "auth");
    f.write("src/a", "changed\n");
    if (tamper) f.write(".npmrc", "script-shell=/bin/true\n");
    f.commit();
    const result = push(f, "HEAD", "refs/heads/main");
    if (tamper) {
      reject(result, /formal runner \.npmrc changed/i);
      assert.deepEqual(f.commands(), []);
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(f.commands(), ["run verify:auth-formal"]);
    }
  }
});

test("production Cargo runners reject added configuration in each searched directory", (t) => {
  for (const id of [
    "authority",
    "spiffe",
    "source-lifetime",
    "source-trust-selection",
    "spiffe-peer-domain",
    "nats-trust-rotation",
    "source-history",
  ]) {
    for (const dir of PINNED_FORMAL_RUNNERS[id].cargoConfigDirs)
      for (const name of ["config", "config.toml"]) {
        const f = productionFixture(t, id);
        f.write("src/a", "changed\n");
        f.write(`${dir}/${name}`, "[target.'cfg(unix)']\nrunner='/bin/true'\n");
        f.commit();
        const result = push(f, "HEAD", "refs/heads/main");
        reject(result, /Cargo runner configuration .*changed/i);
        assert.deepEqual(f.commands(), [], `${id}: ${dir}/${name}`);
      }
  }
});

test("Cargo execution metadata changes, reversions, and symlinks fail closed", (t) => {
  for (const kind of [
    "modified",
    "removed",
    "reverted",
    "symlink",
    "build-added",
    "build-removed",
  ]) {
    const config = kind.startsWith("build-")
      ? "spec/formal/authority/build.rs"
      : ".cargo/config.toml";
    const f = productionFixture(t, "authority", (f) => {
      if (["modified", "removed", "build-removed"].includes(kind))
        f.write(config, "[net]\noffline=true\n");
    });
    if (kind === "symlink") symlinkSync("elsewhere", join(f.repo, ".cargo"));
    else if (["removed", "build-removed"].includes(kind))
      rmSync(join(f.repo, config));
    else f.write(config, "[target.'cfg(unix)']\nrunner='/bin/true'\n");
    f.commit();
    if (kind === "reverted") {
      rmSync(join(f.repo, config));
      f.commit();
    }
    f.write("src/a", "changed\n");
    f.commit();
    const result = push(f, "HEAD", "refs/heads/main");
    reject(
      result,
      kind === "symlink"
        ? /optional runner metadata .*not a regular file/i
        : /Cargo runner configuration|Formal runner metadata/i,
    );
    assert.deepEqual(f.commands(), [], kind);
  }
});

test("rejects selected and shared runner changes and malformed or nonregular runners", (t) => {
  for (const kind of [
    "changed",
    "shared",
    "npmrc",
    "missing",
    "symlink",
    "invalid-package",
  ]) {
    const f = fixture(t);
    installHook(f);
    f.write("src/a", "changed\n");
    const runner = join(f.repo, "scripts/test/a-runner.sh");
    if (kind === "changed")
      f.write("scripts/test/a-runner.sh", "#!/bin/sh\ntrue\n");
    if (kind === "shared")
      f.write("scripts/test/shared-runner.sh", "#!/bin/sh\ntrue\n");
    if (kind === "npmrc") f.write(".npmrc", "script-shell=/bin/true\n");
    if (kind === "missing") rmSync(runner);
    if (kind === "symlink") {
      rmSync(runner);
      symlinkSync("b-runner.sh", runner);
    }
    if (kind === "invalid-package") f.write("package.json", "{\n");
    f.commit();
    reject(push(f, "HEAD", "refs/heads/main"));
    assert.deepEqual(f.commands(), []);
  }
});

test("detects reverted runner tampering, including through a merge", (t) => {
  for (const merge of [false, true]) {
    const f = fixture(t);
    installHook(f);
    const branch = f.git("branch", "--show-current");
    if (merge) f.git("checkout", "-qb", "runner-tampering");
    f.write("scripts/test/a-runner.sh", "#!/bin/sh\ntrue\n");
    f.commit();
    f.write("scripts/test/a-runner.sh", "#!/bin/sh\nexit 0\n");
    f.commit();
    if (merge) {
      f.git("checkout", "-q", branch);
      f.write("src/a", "changed\n");
      f.commit();
      f.git(
        "-c",
        "commit.gpgsign=false",
        "merge",
        "--no-ff",
        "-qm",
        "merge",
        "runner-tampering",
      );
    } else {
      f.write("src/a", "changed\n");
      f.commit();
    }
    reject(push(f, "HEAD", "refs/heads/main"), /formal runner .*changed/i);
    assert.deepEqual(f.commands(), []);
  }
});

test("permits reviewed runner-only metadata before a later implementation change", (t) => {
  const f = fixture(t);
  installHook(f);
  f.write("scripts/test/a-runner.sh", "#!/bin/sh\necho reviewed\n");
  changeScript(f, "verify:a", "bash scripts/test/a-runner.sh --reviewed");
  f.commit();
  const metadata = push(f, "HEAD", "refs/heads/main");
  assert.equal(metadata.status, 0, metadata.stderr);
  assert.deepEqual(f.commands(), []);
  advertise(f, "main");
  f.write("src/a", "changed\n");
  f.commit();
  const implementation = push(f, "HEAD", "refs/heads/main");
  assert.equal(implementation.status, 0, implementation.stderr);
  assert.deepEqual(f.commands(), ["run verify:a"]);
});

test("a new runner inventory entry requires an advertised metadata predecessor", (t) => {
  for (const separate of [false, true]) {
    const f = fixture(t);
    installHook(f);
    const pins = "scripts/security/formal-proof-runner-pins.json";
    const rows = JSON.parse(readFileSync(join(f.repo, pins), "utf8"));
    rows.find((row) => row[1] === "a")[3].push("scripts/test/new-runner.sh");
    f.write(pins, JSON.stringify(rows));
    f.write("scripts/test/new-runner.sh", "#!/bin/sh\nexit 0\n");
    if (separate) {
      f.commit();
      const metadata = push(f, "HEAD", "refs/heads/main");
      assert.equal(metadata.status, 0, metadata.stderr);
      advertise(f, "main");
    }
    f.write("src/a", "changed\n");
    f.commit();
    const result = push(f, "HEAD", "refs/heads/main");
    if (separate) {
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(f.commands(), ["run verify:a"]);
    } else {
      reject(result, /formal runner .*missing/i);
      assert.deepEqual(f.commands(), []);
    }
  }
});

test("permits unrelated scripts and evolving proof evidence with a mapped change", (t) => {
  const f = fixture(t);
  installHook(f);
  f.write("src/a", "changed\n");
  changeScript(f, "unrelated", "echo ok");
  f.write("scripts/test/b-runner.sh", "#!/bin/sh\necho unrelated\n");
  f.write("spec/formal/a/proof", "new model\n");
  f.write("spec/formal/a/coverage.json", "{}\n");
  f.write("spec/formal/a/correspondence.test.mjs", "// updated test\n");
  f.commit();
  const result = push(f, "HEAD", "refs/heads/main");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.commands(), ["run verify:a"]);
});

function advertisePredecessor(f) {
  installHook(f);
  // Main predates the runner; only the advertised stack predecessor has it.
  rmSync(join(f.repo, "scripts/test/spiffe-runner.sh"));
  f.write("src/spiffe", "original\n");
  f.commit();
  advertise(f, "main");
  const policy = structuredClone(registry);
  policy.suites.push({
    id: "spiffe",
    implementation: ["src/spiffe"],
    proofs: ["spec/formal/spiffe/proof"],
    command: ["npm", "run", "verify:spiffe"],
  });
  f.pin(policy);
  f.write("spec/formal/spiffe/proof", "proof\n");
  f.write("spec/formal/proof-registry.json", JSON.stringify(policy));
  f.write("spec/formal/proof-requirements.json", JSON.stringify(policy));
  f.commit();
  advertise(f, "predecessor");
}

test("new stacked refs use an advertised predecessor, while rejecting unadvertised tampering", (t) => {
  for (const tamper of [false, true]) {
    const f = fixture(t);
    advertisePredecessor(f);
    f.write("src/spiffe", "changed\n");
    if (tamper) f.write("scripts/test/spiffe-runner.sh", "#!/bin/sh\ntrue\n");
    f.commit();
    const result = push(f, "HEAD", "refs/heads/ownership");
    if (tamper) {
      reject(result, /formal runner .*changed/i);
      assert.deepEqual(f.commands(), []);
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(f.commands(), ["run verify:spiffe"]);
    }
  }
});

test("a merge of incomparable advertised predecessors requires their runners to agree", (t) => {
  for (const agree of [true, false]) {
    const f = fixture(t);
    installHook(f);
    advertise(f, "main");
    const base = f.git("rev-parse", "HEAD");
    f.git("checkout", "-qb", "left", base);
    f.write("src/other", "left\n");
    f.write("scripts/test/a-runner.sh", "#!/bin/sh\necho left\n");
    f.commit();
    advertise(f, "left");
    f.git("checkout", "-qb", "right", base);
    f.write("src/other", "right\n");
    f.write(
      "scripts/test/a-runner.sh",
      agree ? "#!/bin/sh\necho left\n" : "#!/bin/sh\necho right\n",
    );
    f.commit();
    advertise(f, "right");
    f.git("checkout", "-q", "left");
    f.git(
      "-c",
      "commit.gpgsign=false",
      "merge",
      "-s",
      "ours",
      "--no-ff",
      "-qm",
      "merge",
      "right",
    );
    f.write("src/a", "changed\n");
    f.commit();
    const result = push(f, "HEAD", "refs/heads/combined");
    if (agree) {
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(f.commands(), ["run verify:a"]);
    } else {
      reject(result, /formal runner .*changed/i);
      assert.deepEqual(f.commands(), []);
    }
  }
});
