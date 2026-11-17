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
  join(directory, "IssuerTrustResolution.tla"),
  "utf8",
);

function counterexample(invariant, model = original) {
  const jar = process.env.TLA2TOOLS_JAR;
  validateJar(jar);
  const scratch = mkdtempSync(join(tmpdir(), "opensesame-issuer-fault-"));
  try {
    writeFileSync(join(scratch, "IssuerTrustResolution.tla"), model);
    writeFileSync(
      join(scratch, "IssuerTrustResolution.cfg"),
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
        "IssuerTrustResolution.cfg",
        "IssuerTrustResolution.tla",
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

test("a suspended organization can fall through to an active visitor issuer", () => {
  assert.match(
    counterexample("SuspendedOrgWithByoUnreachable"),
    /<ReadStatic[\s\S]*<ReadOrg[\s\S]*<ReadByo/,
  );
});

test("organization trust can become stale after resolution", () => {
  assert.match(
    counterexample("RevokedAfterResolutionUnreachable"),
    /<ReadStatic[\s\S]*<ReadOrg[\s\S]*<ChangeOrg/,
  );
});

test("skipping a static provider violates its precedence", () => {
  const mutant = mutate(
    '/\\ phase\' = IF staticTrusted THEN "done" ELSE "org"\n  /\\ result\' = IF staticTrusted THEN "static" ELSE "pending"',
    '/\\ phase\' = "org"\n  /\\ result\' = "pending"',
  );
  assert.match(counterexample("StaticPrecedes", mutant), /<ReadStatic/);
});

test("admitting an inactive organization violates admission", () => {
  const mutant = mutate(
    'eligible == orgState = "active" /\\ orgApproved',
    "eligible == orgApproved",
  );
  assert.match(counterexample("OrgWasAdmitted", mutant), /<ReadOrg/);
});

test("bypassing an eligible organization violates its precedence", () => {
  const mutant = mutate(
    'eligible == orgState = "active" /\\ orgApproved',
    "eligible == FALSE",
  );
  assert.match(counterexample("OrgPrecedesByo", mutant), /<ReadOrg/);
});

test("admitting a disabled visitor issuer violates its state check", () => {
  const mutant = mutate(
    'IF byoState = "active" THEN "byo"',
    'IF byoState # "absent" THEN "byo"',
  );
  assert.match(counterexample("ByoWasActive", mutant), /<ReadByo/);
});
