import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateJar } from "../../apps/pages/scripts/verify-ui-model.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const original = readFileSync(join(directory, "AgentRegistration.tla"), "utf8");

function counterexample(invariant, model = original) {
  const jar = process.env.TLA2TOOLS_JAR;
  validateJar(jar);
  const scratch = mkdtempSync(join(tmpdir(), "opensesame-agent-fault-"));
  try {
    writeFileSync(join(scratch, "AgentRegistration.tla"), model);
    writeFileSync(
      join(scratch, "AgentRegistration.cfg"),
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
        "AgentRegistration.cfg",
        "AgentRegistration.tla",
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

test("a pending claim can reach claimed", () => {
  assert.match(counterexample("ClaimUnreachable"), /<Pending[\s\S]*<Claim/);
});

test("a claimed registration remains revocable after the pre-claim deadline", () => {
  assert.match(
    counterexample("PostDeadlineRevokeUnreachable"),
    /<Claim[\s\S]*<Advance[\s\S]*<Revoke|<Advance[\s\S]*<Claim[\s\S]*<Revoke/,
  );
});

test("allowing a post-deadline claim violates the deadline policy", () => {
  const model = mutate(
    'registration.status # "claimed" /\\ now # "before"',
    'registration.status # "claimed" /\\ now = "before"',
  );
  assert.match(counterexample("NoLateClaim", model), /<Claim/);
});

test("allowing an empty claimant violates claim binding", () => {
  const model = mutate('ELSE IF person = "none"', "ELSE IF FALSE");
  assert.match(
    counterexample("ClaimRequiresPendingAndPerson", model),
    /<Claim/,
  );
});
