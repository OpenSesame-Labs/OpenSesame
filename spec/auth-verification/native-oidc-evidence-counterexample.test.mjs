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
  join(directory, "NativeOidcEvidence.tla"),
  "utf8",
);

function rejected(model, config) {
  const jar = process.env.TLA2TOOLS_JAR;
  validateJar(jar);
  const scratch = mkdtempSync(join(tmpdir(), "opensesame-oidc-evidence-"));
  try {
    writeFileSync(join(scratch, "NativeOidcEvidence.tla"), model);
    writeFileSync(join(scratch, "NativeOidcEvidence.cfg"), config);
    const result = spawnSync(
      "java",
      [
        "-XX:+UseParallelGC",
        "-cp",
        resolve(jar),
        "tlc2.TLC",
        "-workers",
        "1",
        "-metadir",
        join(scratch, "state"),
        "-config",
        "NativeOidcEvidence.cfg",
        "NativeOidcEvidence.tla",
      ],
      { cwd: scratch, encoding: "utf8" },
    );
    if (result.error) throw result.error;
    assert.notEqual(result.status, 0, "TLC must reject this negative control");
    return `${result.stdout}\n${result.stderr}`;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function invariant(name, model = original) {
  const output = rejected(
    model,
    `SPECIFICATION Spec\nCHECK_DEADLOCK FALSE\nINVARIANT ${name}\n`,
  );
  assert.ok(output.includes(`Invariant ${name} is violated`));
  return output;
}

test("a real issued proof can reach successful consumption", () => {
  assert.match(invariant("SuccessUnreachable"), /<Issue[\s\S]*<Consume/);
});

test("a retired or expired proof can reach a consuming denial", () => {
  assert.match(
    invariant("InvalidConsumptionUnreachable"),
    /<Issue[\s\S]*<(?:Retire|Expire)[\s\S]*<Consume/,
  );
});

test("TLC rejects a model that fails to delete consumed evidence", () => {
  const before = 'present\' = IF who = "genuine" THEN FALSE ELSE present';
  assert.equal(original.split(before).length, 2);
  const mutant = original.replace(before, "present' = present");
  assert.match(invariant("SpentNeverReappears", mutant), /<Consume/);
});

test("eventual consumption requires the stated fairness assumption", () => {
  const output = rejected(
    original,
    "SPECIFICATION Spec\nCHECK_DEADLOCK FALSE\nPROPERTY EventuallyConsumed\n",
  );
  assert.match(output, /Temporal properties were violated/);
  assert.match(output, /<Issue/);
});
