import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("DeepSec gate checks installed XML and forwards all options to the CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "opensesame-deepsec-gate-"));
  try {
    mkdirSync(join(dir, "scripts/audit"), { recursive: true });
    mkdirSync(join(dir, ".deepsec/node_modules/deepsec"), { recursive: true });
    cpSync(
      join(root, "scripts/audit/deepsec-gate.sh"),
      join(dir, "scripts/audit/deepsec-gate.sh"),
    );
    const workspace = join(dir, ".deepsec");
    const actual = JSON.parse(
      readFileSync(join(root, ".deepsec/package.json"), "utf8"),
    );
    assert.equal(actual.scripts.deepsec, "deepsec");
    assert.equal(
      actual.scripts["test:aws-xml"],
      "node --test aws-xml-compat.test.mjs",
    );
    writeFileSync(
      join(workspace, "package.json"),
      JSON.stringify({
        private: true,
        scripts: {
          deepsec: "node fake-cli.cjs",
          "test:aws-xml": "node preflight.cjs",
        },
      }),
    );
    writeFileSync(
      join(workspace, "preflight.cjs"),
      'require("node:fs").appendFileSync(process.env.OPENSESAME_TEST_DEEPSEC_LOG, JSON.stringify(["preflight"]) + "\\n");',
    );
    writeFileSync(
      join(workspace, "fake-cli.cjs"),
      'require("node:fs").appendFileSync(process.env.OPENSESAME_TEST_DEEPSEC_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");',
    );
    const log = resolve(dir, "calls.jsonl");
    execFileSync("bash", [join(dir, "scripts/audit/deepsec-gate.sh")], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        OPENSESAME_TEST_DEEPSEC_LOG: log,
        DEEPSEC_PROCESS: "1",
        DEEPSEC_AGENT: "test-agent",
        DEEPSEC_MODEL: "test-model",
        DEEPSEC_CONCURRENCY: "3",
        DEEPSEC_THINKING: "low",
      },
    });
    const calls = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(calls[0], ["preflight"]);
    assert.deepEqual(calls[1], ["scan", "--project-id", "opensesame"]);
    assert.deepEqual(calls[2], [
      "process",
      "--project-id",
      "opensesame",
      "--agent",
      "test-agent",
      "--model",
      "test-model",
      "--thinking-level",
      "low",
      "--concurrency",
      "3",
    ]);
    assert.deepEqual(calls[3], [
      "export",
      "--project-id",
      "opensesame",
      "--format",
      "md-dir",
      "--out",
      "./findings",
    ]);
    assert.deepEqual(calls[4], ["status", "--project-id", "opensesame"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
