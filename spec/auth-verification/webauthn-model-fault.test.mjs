import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateJar } from "../../apps/pages/scripts/verify-ui-model.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const original = readFileSync(join(directory, "WebAuthnChallenge.tla"), "utf8");

function counterexample(invariant, model = original) {
  const jar = process.env.TLA2TOOLS_JAR;
  validateJar(jar);
  const scratch = mkdtempSync(join(tmpdir(), "opensesame-webauthn-fault-"));
  try {
    writeFileSync(join(scratch, "WebAuthnChallenge.tla"), model);
    writeFileSync(
      join(scratch, "WebAuthnChallenge.cfg"),
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
        "WebAuthnChallenge.cfg",
        "WebAuthnChallenge.tla",
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

test("a valid assertion can reach acceptance", () => {
  assert.match(
    counterexample("AcceptanceUnreachable"),
    /<Issue[\s\S]*<Begin[\s\S]*<Finish/,
  );
});

test("a registration challenge can reach a consuming denial", () => {
  assert.match(
    counterexample("RegistrationDenialUnreachable"),
    /<Issue[\s\S]*<Begin[\s\S]*<Finish/,
  );
});

test("removing consumption violates one-use custody", () => {
  const mutant = mutate(
    "  /\\ present' = FALSE\n",
    "  /\\ present' = present\n",
  );
  assert.match(counterexample("SpentCannotReappear", mutant), /<Begin/);
});

test("allowing registration for assertions violates purpose binding", () => {
  const mutant = mutate("requestedPurpose \\in Allowed /\\", "TRUE /\\");
  assert.match(
    counterexample("AcceptedPurposeMatches", mutant),
    /<Issue[\s\S]*<Begin[\s\S]*<Finish/,
  );
});
