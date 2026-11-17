import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateJar } from "../../apps/pages/scripts/verify-ui-model.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const original = readFileSync(join(directory, "SamlReplayCustody.tla"), "utf8");

function counterexample(invariant, model = original, spec = "Spec") {
  const jar = process.env.TLA2TOOLS_JAR;
  validateJar(jar);
  const scratch = mkdtempSync(join(tmpdir(), "opensesame-saml-fault-"));
  try {
    writeFileSync(join(scratch, "SamlReplayCustody.tla"), model);
    writeFileSync(
      join(scratch, "SamlReplayCustody.cfg"),
      `SPECIFICATION ${spec}\nCHECK_DEADLOCK FALSE\nINVARIANT ${invariant}\n`,
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
        "SamlReplayCustody.cfg",
        "SamlReplayCustody.tla",
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

test("an unexpired assertion can be accepted", () => {
  assert.match(counterexample("AcceptanceUnreachable"), /<Claim/);
});

test("a restart permits replay in volatile custody even without advancing time", () => {
  const model = mutate(
    "Spec == Init /\\ [][Next]_vars",
    "Spec == Init /\\ [][Next]_vars\nFixedTime == Init /\\ [][Restart \\/ (\\E key \\in Keys, expiry \\in 0..3: Claim(key, expiry))]_vars",
  );
  assert.match(
    counterexample("NoReplayAcrossRestartOrExpiry", model, "FixedTime"),
    /<Claim[\s\S]*<Restart[\s\S]*<Claim/,
  );
});

test("accepting a retained replay violates custody", () => {
  const model = mutate("key \\notin active /\\", "TRUE /\\");
  assert.match(
    counterexample("RetainedReplayDenied", model),
    /<Claim[\s\S]*<Claim/,
  );
});

test("accepting a full store violates its capacity bound", () => {
  const model = mutate(
    "Cardinality(active) < Capacity",
    "Cardinality(active) <= Capacity",
  );
  assert.match(counterexample("CapacityRespected", model), /<Claim/);
});

test("acceptance at expiry violates the deadline policy", () => {
  const model = mutate("accepted == expiry > now", "accepted == expiry >= now");
  assert.match(counterexample("ExpiredAssertionDenied", model), /<Claim/);
});
