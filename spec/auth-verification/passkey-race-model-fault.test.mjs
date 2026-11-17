import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateJar } from "../../apps/pages/scripts/verify-ui-model.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const original = readFileSync(
  join(directory, "PasskeyCredentialRace.tla"),
  "utf8",
);

function counterexample(invariant, model = original) {
  const jar = process.env.TLA2TOOLS_JAR;
  validateJar(jar);
  const scratch = mkdtempSync(join(tmpdir(), "opensesame-passkey-fault-"));
  try {
    writeFileSync(join(scratch, "PasskeyCredentialRace.tla"), model);
    writeFileSync(
      join(scratch, "PasskeyCredentialRace.cfg"),
      `SPECIFICATION Spec\nCHECK_DEADLOCK FALSE\nINVARIANT ${invariant}\n`,
    );
    const result = spawnSync(
      "java",
      [
        "-XX:+UseParallelGC",
        "-Xmx2g",
        "-cp",
        resolve(jar),
        "tlc2.TLC",
        "-workers",
        "1",
        "-metadir",
        join(scratch, "state"),
        "-config",
        "PasskeyCredentialRace.cfg",
        "PasskeyCredentialRace.tla",
      ],
      { cwd: scratch, encoding: "utf8" },
    );
    if (result.error) throw result.error;
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0, "the negative control must fail");
    assert.ok(output.includes(`Invariant ${invariant} is violated`));
    return output;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function mutate(before, after) {
  assert.equal(original.split(before).length, 2, "mutation must match once");
  return original.replace(before, after);
}

test("a valid credential can be accepted", () => {
  assert.match(counterexample("AcceptanceUnreachable"), /<Begin[\s\S]*<Finish/);
});

test("a verification begun before replacement can be rejected", () => {
  assert.match(
    counterexample("ReplacementRejectionUnreachable"),
    /<Begin[\s\S]*<Remove[\s\S]*<Register[\s\S]*<Finish/,
  );
});

test("omitting the generation check accepts a replacement credential", () => {
  const mutant = mutate(
    "current == present /\\ generation = readGeneration[c]",
    "current == present",
  );
  assert.match(
    counterexample("AcceptedLiveAtConfirmation", mutant),
    /<Begin[\s\S]*<Remove[\s\S]*<Register[\s\S]*<Finish/,
  );
});

test("omitting the owner check allows unauthorized removal", () => {
  const mutant = mutate("/\\ present /\\ person = owner", "/\\ present");
  assert.match(counterexample("RemovalWasAuthorized", mutant), /<Remove/);
});

test("omitting counter advancement permits duplicate positive counters", () => {
  const mutant = mutate(
    '(nextCounter = "one" /\\ counter < 1)',
    '(nextCounter = "one")',
  );
  assert.match(
    counterexample("PositiveCounterSpentOncePerGeneration", mutant),
    /<Finish/,
  );
});
