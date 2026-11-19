import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PINNED_FORMAL_SUITES } from "./formal-proof-pinned-suites.mjs";

const REQUIREMENTS = JSON.parse(
  readFileSync(
    new URL("../../spec/formal/proof-requirements.json", import.meta.url),
  ),
);
const REQUIRED_FORMAL_SUITES = REQUIREMENTS.suites;

const script = fileURLToPath(
  new URL("./formal-proof-release-gate.mjs", import.meta.url),
);
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "formal-release-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "spec/formal"), { recursive: true });
  writeFileSync(
    join(dir, "bin/npm"),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FORMAL_TEST_LOG"\n',
    { mode: 0o755 },
  );
  writeFileSync(
    join(dir, "spec/formal/check-axioms.sh"),
    "#!/bin/sh\nexit 0\n",
  );
  writeFileSync(
    join(dir, "spec/formal/check-axioms.test.mjs"),
    "import { test } from 'node:test'; test('control', () => {});\n",
  );
  writeFileSync(
    join(dir, "spec/formal/required-theorem-command.lean"),
    "proof",
  );
  const suites = structuredClone(REQUIRED_FORMAL_SUITES);
  writeFileSync(
    join(dir, "spec/formal/proof-registry.json"),
    JSON.stringify({ version: 1, suites }),
  );
  writeFileSync(
    join(dir, "spec/formal/proof-requirements.json"),
    JSON.stringify(REQUIREMENTS),
  );
  for (const suite of suites) {
    for (const proof of suite.proofs) {
      const path = join(dir, proof);
      if (
        proof === "spec/formal/check-axioms.sh" ||
        proof === "spec/formal/check-axioms.test.mjs" ||
        proof === "spec/formal/required-theorem-command.lean"
      )
        continue;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "proof");
    }
  }
  const log = join(dir, "log");
  const run = (env = {}) =>
    spawnSync(process.execPath, [script], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(dir, "bin")}:${process.env.PATH}`,
        FORMAL_TEST_LOG: log,
        ...env,
      },
    });
  const commands = () => {
    try {
      return readFileSync(log, "utf8").trim().split("\n");
    } catch {
      return [];
    }
  };
  return { dir, run, commands };
}
test("release qualification executes every registered proof and fails on a missing proof", (t) => {
  const f = fixture(t);
  const success = f.run();
  assert.equal(success.status, 0, success.stderr);
  assert.deepEqual(
    f.commands(),
    REQUIRED_FORMAL_SUITES.map((suite) => `run ${suite.command[2]}`),
  );
  rmSync(join(f.dir, "spec/formal/oauth/PendingIntegrity.lean"));
  const missing = f.run();
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /PendingIntegrity.lean.*missing/);
});
test("release qualification rejects weakened suite contracts", (t) => {
  const f = fixture(t);
  const path = join(f.dir, "spec/formal/proof-registry.json");
  const original = JSON.parse(readFileSync(path, "utf8"));
  for (const required of REQUIRED_FORMAL_SUITES) {
    for (const kind of [
      "implementation",
      "model",
      "obligations",
      "extra-proof",
      "command",
    ]) {
      const changed = structuredClone(original);
      const suite = changed.suites.find((entry) => entry.id === required.id);
      if (kind === "implementation") suite.implementation.shift();
      if (kind === "model") suite.proofs.shift();
      if (kind === "obligations") suite.proofs.splice(1, 1);
      if (kind === "extra-proof") suite.proofs.push("spec/formal/extra.lean");
      if (kind === "command") suite.command[2] = "verify:noop";
      writeFileSync(path, JSON.stringify(changed));
      const result = f.run();
      assert.notEqual(result.status, 0, `${required.id}: ${kind}`);
      assert.match(
        result.stderr,
        /does not match required mappings, proofs, or command/,
      );
      assert.deepEqual(f.commands(), []);
    }
  }
});
test("release qualification requires new mappings to be pinned", (t) => {
  const f = fixture(t);
  const path = join(f.dir, "spec/formal/proof-registry.json");
  const registry = JSON.parse(readFileSync(path, "utf8"));
  registry.suites[0].implementation.push("src/additional");
  writeFileSync(path, JSON.stringify(registry));
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /does not match required mappings, proofs, or command/,
  );
  assert.deepEqual(f.commands(), []);
});
test("release qualification requires a regular, valid requirements manifest", (t) => {
  for (const kind of ["missing", "invalid", "duplicate-proof", "symlink"]) {
    const f = fixture(t);
    const path = join(f.dir, "spec/formal/proof-requirements.json");
    if (kind === "missing") rmSync(path);
    if (kind === "invalid") writeFileSync(path, "not JSON");
    if (kind === "duplicate-proof") {
      const malformed = structuredClone(REQUIREMENTS);
      malformed.suites[0].proofs.push(malformed.suites[0].proofs[0]);
      writeFileSync(path, JSON.stringify(malformed));
    }
    if (kind === "symlink") {
      rmSync(path);
      symlinkSync("proof-registry.json", path);
    }
    const result = f.run();
    assert.notEqual(result.status, 0, kind);
    assert.match(result.stderr, /requirements|policy/i);
    assert.deepEqual(f.commands(), []);
  }
});
test("release qualification refuses to lose a required suite", (t) => {
  const f = fixture(t);
  const path = join(f.dir, "spec/formal/proof-registry.json");
  const registry = JSON.parse(readFileSync(path, "utf8"));
  for (const suite of registry.suites) {
    writeFileSync(
      path,
      JSON.stringify({
        ...registry,
        suites: registry.suites.filter((entry) => entry.id !== suite.id),
      }),
    );
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`suite ${suite.id} is missing`));
    assert.deepEqual(f.commands(), []);
  }
});
test("the independently pinned suite contracts survive coordinated JSON weakening", (t) => {
  assert.deepEqual(
    PINNED_FORMAL_SUITES.map((suite) => suite.id),
    ["auth", "oauth", "webauthn", "interaction-clock", "authority", "dpop", "spiffe", "source-lifetime"],
  );
  for (const id of ["auth", "oauth", "webauthn", "interaction-clock", "authority", "dpop", "spiffe", "source-lifetime"]) {
    for (const kind of ["suite", "mapping", "proof", "command"]) {
      const f = fixture(t);
      const altered = structuredClone(REQUIREMENTS);
      const suite = altered.suites.find((entry) => entry.id === id);
      if (kind === "suite")
        altered.suites = altered.suites.filter((entry) => entry.id !== id);
      if (kind === "mapping") suite.implementation.shift();
      if (kind === "proof") suite.proofs.shift();
      if (kind === "command") suite.command[2] = "verify:noop";
      for (const name of ["proof-registry.json", "proof-requirements.json"])
        writeFileSync(
          join(f.dir, "spec/formal", name),
          JSON.stringify(altered),
        );
      const result = f.run();
      assert.notEqual(result.status, 0, `${id}: ${kind}`);
      assert.match(result.stderr, /required|mapping|proof/i);
      assert.deepEqual(f.commands(), []);
    }
  }
});
test("the pinned SPIFFE and source-lifetime lock projections cannot be weakened", (t) => {
  for (const id of ["spiffe", "source-lifetime"]) {
    for (const kind of ["remove", "root", "dependency"]) {
      const f = fixture(t);
      const altered = structuredClone(REQUIREMENTS);
      const suite = altered.suites.find((entry) => entry.id === id);
      if (kind === "remove") delete suite.lockProjection;
      if (kind === "root") suite.lockProjection.root = "other";
      if (kind === "dependency") suite.lockProjection.dependency = "spiffe";
      for (const name of ["proof-registry.json", "proof-requirements.json"])
        writeFileSync(
          join(f.dir, "spec/formal", name),
          JSON.stringify(altered),
        );
      const result = f.run();
      assert.notEqual(result.status, 0, `${id}: ${kind}`);
      assert.match(result.stderr, /required|mapping|proof/i);
      assert.deepEqual(f.commands(), []);
    }
  }
});
test("the pinned authority manifest and lock projections cannot be removed or narrowed", (t) => {
  for (const kind of [
    "remove-manifest",
    "manifest-root",
    "manifest-package",
    "manifest-lock",
    "remove-lock",
    "lock-root",
  ]) {
    const f = fixture(t);
    const altered = structuredClone(REQUIREMENTS);
    const suite = altered.suites.find((entry) => entry.id === "authority");
    if (kind === "remove-manifest") delete suite.manifestProjection;
    if (kind === "manifest-root") suite.manifestProjection.root = "other";
    if (kind === "manifest-package")
      suite.manifestProjection.package = "crates/other/Cargo.toml";
    if (kind === "manifest-lock") suite.manifestProjection.lock = "other.lock";
    if (kind === "remove-lock") delete suite.lockProjection;
    if (kind === "lock-root") suite.lockProjection.root = "other";
    for (const name of ["proof-registry.json", "proof-requirements.json"])
      writeFileSync(join(f.dir, "spec/formal", name), JSON.stringify(altered));
    const result = f.run();
    assert.notEqual(result.status, 0, kind);
    assert.match(result.stderr, /required|mapping|proof|invalid/i);
    assert.deepEqual(f.commands(), []);
  }
});
test("release qualification propagates a suite failure", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.dir, "bin/npm"), "#!/bin/sh\nexit 9\n", { mode: 0o755 });
  const failure = f.run();
  assert.notEqual(failure.status, 0);
  assert.match(failure.stderr, /suite auth failed/);
});
test("missing or failing axiom controls stop qualification before any suite", (t) => {
  const missing = fixture(t);
  rmSync(join(missing.dir, "spec/formal/check-axioms.sh"));
  const absent = missing.run();
  assert.notEqual(absent.status, 0);
  assert.match(absent.stderr, /check-axioms.sh.*missing/);
  assert.deepEqual(missing.commands(), []);

  const missingCommand = fixture(t);
  rmSync(join(missingCommand.dir, "spec/formal/required-theorem-command.lean"));
  const absentCommand = missingCommand.run();
  assert.notEqual(absentCommand.status, 0);
  assert.match(absentCommand.stderr, /required-theorem-command.lean.*missing/);
  assert.deepEqual(missingCommand.commands(), []);

  const failing = fixture(t);
  writeFileSync(
    join(failing.dir, "spec/formal/check-axioms.test.mjs"),
    "throw new Error('control failure');\n",
  );
  const result = failing.run({ NODE_TEST_CONTEXT: "child-v8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /axiom control tests failed/);
  assert.deepEqual(failing.commands(), []);
});
