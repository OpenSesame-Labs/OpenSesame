import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateJar } from "../../apps/pages/scripts/verify-ui-model.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const original = readFileSync(join(directory, "ClaimLifecycle.tla"), "utf8");

function counterexample(invariant, model = original) {
  const jar = process.env.TLA2TOOLS_JAR;
  validateJar(jar);
  const scratch = mkdtempSync(join(tmpdir(), "opensesame-claim-fault-"));
  try {
    writeFileSync(join(scratch, "ClaimLifecycle.tla"), model);
    writeFileSync(
      join(scratch, "ClaimLifecycle.cfg"),
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
        "ClaimLifecycle.cfg",
        "ClaimLifecycle.tla",
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

test("a reviewed claim can reach completion", () => {
  assert.match(
    counterexample("CompletionUnreachable"),
    /<Progress[\s\S]*<Progress[\s\S]*<Progress[\s\S]*<Progress/,
  );
});

test("a claim at the deadline can reach a denial", () => {
  assert.match(
    counterexample("DeadlineDenialUnreachable"),
    /<Advance[\s\S]*<Progress/,
  );
});

test("completion without review violates the lifecycle policy", () => {
  const model = mutate(
    '(from = "authenticated" /\\ target \\in {"reviewed", "revoked", "expired"})',
    '(from = "authenticated" /\\ target \\in {"reviewed", "completed", "revoked", "expired"})',
  );
  assert.match(counterexample("CompletionRequiresReview", model), /<Progress/);
});

test("completion without a principal violates the lifecycle policy", () => {
  const model = mutate('target = "completed" /\\ person = ""', "FALSE");
  assert.match(counterexample("CompletionRequiresReview", model), /<Progress/);
});

test("changing a bound manifest digest violates the binding policy", () => {
  const model = mutate(
    "!.version = @ + 1,\n",
    '!.version = @ + 1, !.manifestDigest = "different",\n',
  );
  assert.match(counterexample("BindingsPreserved", model), /<Progress/);
});

test("progress after expiry violates the deadline policy", () => {
  const model = mutate(
    '(now # "before" /\\ claim.state \\notin Terminal)',
    '(now = "before" /\\ claim.state \\notin Terminal)',
  );
  assert.match(
    counterexample("NoLateProgress", model),
    /<Advance[\s\S]*<Progress/,
  );
});
