import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));

function rejectsFault(original, replacement, invariant) {
  const jar = process.env.TLA2TOOLS_JAR;
  assert.ok(jar, "TLA2TOOLS_JAR is required for the model fault check");
  const source = readFileSync(join(directory, "ToastReading.tla"), "utf8");
  assert.equal(source.split(original).length, 2, "expected one mutation site");
  const mutant = source.replace(original, replacement);
  const scratch = mkdtempSync(join(tmpdir(), "opensesame-toast-mutant-"));
  try {
    writeFileSync(join(scratch, "ToastReading.tla"), mutant);
    writeFileSync(
      join(scratch, "ToastReading.cfg"),
      readFileSync(join(directory, "ToastReading.cfg")),
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
        "ToastReading.cfg",
        "ToastReading.tla",
      ],
      { cwd: scratch, encoding: "utf8" },
    );
    if (result.error) throw result.error;
    assert.notEqual(result.status, 0, "the faulty model must fail");
    assert.ok(
      `${result.stdout}\n${result.stderr}`.includes(
        `Invariant ${invariant} is violated`,
      ),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test("TLC detects a timer that runs while only one input is reading", () => {
  rejectsFault(
    "IF hover \\/ focused\n",
    "IF hover /\\ focused\n",
    "ReadingHoldsTime",
  );
});

test("TLC detects an update that inherits the old remaining time", () => {
  rejectsFault(
    "  /\\ remaining' = MaxTicks\n  /\\ action' = \"update\"",
    '  /\\ UNCHANGED remaining\n  /\\ action\' = "update"',
    "UpdateRestartsTime",
  );
});
