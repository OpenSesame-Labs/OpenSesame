import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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
  const suites = ["a", "b"].map((id) => ({
    id,
    implementation: [`src/${id}`],
    proofs: [`spec/formal/${id}.lean`],
    command: ["npm", "run", `verify:${id}`],
  }));
  writeFileSync(
    join(dir, "spec/formal/proof-registry.json"),
    JSON.stringify({ version: 1, suites }),
  );
  for (const id of ["a", "b"])
    writeFileSync(join(dir, `spec/formal/${id}.lean`), "proof");
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
  assert.deepEqual(f.commands(), ["run verify:a", "run verify:b"]);
  rmSync(join(f.dir, "spec/formal/b.lean"));
  const missing = f.run();
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /b.lean.*missing/);
});
test("release qualification propagates a suite failure", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.dir, "bin/npm"), "#!/bin/sh\nexit 9\n", { mode: 0o755 });
  const failure = f.run();
  assert.notEqual(failure.status, 0);
  assert.match(failure.stderr, /suite a failed/);
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
