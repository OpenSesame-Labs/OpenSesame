import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));

test("TLC detects a timer that runs while only one input is reading", () => {
  const jar = process.env.TLA2TOOLS_JAR;
  assert.ok(jar, "TLA2TOOLS_JAR is required for the model fault check");
  const source = readFileSync(join(directory, "ToastReading.tla"), "utf8");
  const original = "IF hover \\/ focused\n";
  assert.equal(source.split(original).length, 2, "expected one mutation site");
  const mutant = source.replace(original, "IF hover /\\ focused\n");
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
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /Invariant ReadingHoldsTime is violated/,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
