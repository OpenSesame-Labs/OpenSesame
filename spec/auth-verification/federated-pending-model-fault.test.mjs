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
  join(directory, "FederatedPendingIntegrity.tla"),
  "utf8",
);

function counterexample(invariant, model = original) {
  const jar = process.env.TLA2TOOLS_JAR;
  validateJar(jar);
  const scratch = mkdtempSync(join(tmpdir(), "opensesame-pending-fault-"));
  try {
    writeFileSync(join(scratch, "FederatedPendingIntegrity.tla"), model);
    writeFileSync(
      join(scratch, "FederatedPendingIntegrity.cfg"),
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
        "FederatedPendingIntegrity.cfg",
        "FederatedPendingIntegrity.tla",
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

test("a modern signed cookie can be accepted", () => {
  assert.match(counterexample("ModernAcceptanceUnreachable"), /<Verify/);
});

test("a legacy cookie carrying an unbound organization is rejected", () => {
  assert.match(counterexample("LegacyContextRejectionUnreachable"), /<Verify/);
});

test("omitting modern payload binding permits context tampering", () => {
  const mutant = mutate(
    "core = signedCore /\\\n                       org = signedOrg /\\ byo = signedByo",
    "core = signedCore",
  );
  assert.match(
    counterexample("ModernAcceptBindsPayload", mutant),
    /<Alter[\s\S]*<Verify/,
  );
});

test("allowing legacy context grants unauthenticated authority", () => {
  const mutant = mutate(
    'core = signedCore /\\\n                       org = "none" /\\ byo = "none"',
    "core = signedCore",
  );
  assert.match(
    counterexample("LegacyCannotGrantUnboundContext", mutant),
    /<Verify/,
  );
});

test("omitting the legacy core binding permits substitution", () => {
  const mutant = mutate(
    'format = "legacy" /\\ core = signedCore /\\',
    'format = "legacy" /\\',
  );
  assert.match(
    counterexample("AcceptedCoreMatches", mutant),
    /<Alter[\s\S]*<Verify/,
  );
});
