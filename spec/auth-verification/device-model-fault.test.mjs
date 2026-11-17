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
  join(directory, "DeviceAuthorization.tla"),
  "utf8",
);

function counterexample(invariant, model = original) {
  const jar = process.env.TLA2TOOLS_JAR;
  validateJar(jar);
  const scratch = mkdtempSync(join(tmpdir(), "opensesame-device-fault-"));
  try {
    writeFileSync(join(scratch, "DeviceAuthorization.tla"), model);
    writeFileSync(
      join(scratch, "DeviceAuthorization.cfg"),
      `SPECIFICATION Spec\nCHECK_DEADLOCK FALSE\nINVARIANT ${invariant}\n`,
    );
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
        "DeviceAuthorization.cfg",
        "DeviceAuthorization.tla",
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

test("approval followed by consumption is reachable", () => {
  assert.match(
    counterexample("ConsumptionUnreachable"),
    /<Decision[\s\S]*<Decision/,
  );
});

test("a deadline denial is reachable", () => {
  assert.match(
    counterexample("LateDenialUnreachable"),
    /<Advance[\s\S]*<Decision/,
  );
});

test("a late approval violates the deadline policy", () => {
  const model = mutate(
    '(now # "before" /\\ session.state \\notin Terminal)',
    '(now = "before" /\\ session.state \\notin Terminal)',
  );
  assert.match(
    counterexample("NoLateDecision", model),
    /<Advance[\s\S]*<Decision/,
  );
});

test("consuming a pending session violates the approval policy", () => {
  const model = mutate(
    '{"approved", "denied", "expired"}',
    '{"approved", "denied", "expired", "consumed"}',
  );
  assert.match(
    counterexample("ConsumptionRequiresApproval", model),
    /<Decision/,
  );
});
