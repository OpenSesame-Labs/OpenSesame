import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateJar } from "../../apps/pages/scripts/verify-ui-model.mjs";

const directory = dirname(fileURLToPath(import.meta.url));

function counterexample(invariant) {
  const jar = process.env.TLA2TOOLS_JAR;
  validateJar(jar);
  const scratch = mkdtempSync(
    join(tmpdir(), "opensesame-session-counterexample-"),
  );
  try {
    writeFileSync(
      join(scratch, "ProvisionalSessionReads.tla"),
      readFileSync(join(directory, "ProvisionalSessionReads.tla")),
    );
    writeFileSync(
      join(scratch, "ProvisionalSessionReads.cfg"),
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
        "ProvisionalSessionReads.cfg",
        "ProvisionalSessionReads.tla",
      ],
      { cwd: scratch, encoding: "utf8" },
    );
    if (result.error) throw result.error;
    assert.notEqual(
      result.status,
      0,
      `${invariant} must have a counterexample`,
    );
    const output = `${result.stdout}\n${result.stderr}`;
    assert.ok(output.includes(`Invariant ${invariant} is violated`));
    return output;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test("the snapshot model exposes revocation between the session read and return", () => {
  const output = counterexample("AcceptedRequiresCurrentRevocationCheck");
  assert.match(output, /<ReadSession[\s\S]*<Revoke[\s\S]*<Return/);
});

test("a revoked session read can reach a denial", () => {
  const output = counterexample("RevokedSessionDenialUnreachable");
  assert.match(output, /<Revoke[\s\S]*<ReadSession/);
});

test("an already-invalid session can start and reach a denial", () => {
  const output = counterexample("InvalidStartDenialUnreachable");
  assert.match(
    output,
    /<(?:Revoke|Expire|DropToken|DropSession|Suspend)[\s\S]*<Start/,
  );
});
