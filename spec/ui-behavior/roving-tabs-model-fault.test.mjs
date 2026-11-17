import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateJar } from "../../apps/pages/scripts/verify-ui-model.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const original = readFileSync(join(directory, "RovingTabs.tla"), "utf8");

function counterexample(invariant, model = original) {
  const jar = process.env.TLA2TOOLS_JAR;
  validateJar(jar);
  const scratch = mkdtempSync(join(tmpdir(), "opensesame-tabs-fault-"));
  try {
    writeFileSync(join(scratch, "RovingTabs.tla"), model);
    writeFileSync(
      join(scratch, "RovingTabs.cfg"),
      `SPECIFICATION Spec\nINVARIANT ${invariant}\n`,
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
        "RovingTabs.cfg",
        "RovingTabs.tla",
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

test("right-arrow wraparound is reachable", () => {
  assert.match(counterexample("RightWrapUnreachable"), /<Move/);
});

test("moving right on a left arrow violates the keyboard contract", () => {
  const before = 'key = "left" -> IF focus = 0 THEN count - 1 ELSE focus - 1';
  const after = 'key = "left" -> IF focus = count - 1 THEN 0 ELSE focus + 1';
  assert.equal(original.split(before).length, 2);
  assert.match(
    counterexample("LeftMovesBack", original.replace(before, after)),
    /<Move/,
  );
});
