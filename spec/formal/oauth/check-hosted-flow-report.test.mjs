import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isString } from "../../../scripts/lib/json-boundary.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const checker = resolve(root, "spec/formal/oauth/check-hosted-flow-report.mjs");
const suite = "federated leg, organization sign-in";
const titles = [
  "admits the subject and joins it to the tenant",
  "refuses an in-flight sign-in if the issuer changes organizations",
];
const report = () => ({
  success: true,
  numFailedTests: 0,
  numPassedTests: 2,
  testResults: [
    {
      name: resolve(
        root,
        "packages/control-plane/src/__tests__/federated-interaction.test.ts",
      ),
      status: "passed",
      assertionResults: titles.map((title) => ({
        title,
        fullName: `${suite} ${title}`,
        ancestorTitles: [suite],
        status: "passed",
      })),
    },
  ],
});

function check(value) {
  const directory = mkdtempSync(resolve(tmpdir(), "oauth-report-test-"));
  try {
    const path = resolve(directory, "report.json");
    writeFileSync(path, isString(value) ? value : JSON.stringify(value));
    return spawnSync(process.execPath, [checker, path], { encoding: "utf8" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("accepts one passed result for each exact hosted-flow test", () => {
  assert.equal(check(report()).status, 0);
});

test("rejects a missing, skipped, renamed, or duplicated required result", () => {
  for (let index = 0; index < titles.length; index++) {
    for (const mutation of ["missing", "skipped", "renamed", "duplicate"]) {
      const value = report();
      const results = value.testResults[0].assertionResults;
      if (mutation === "missing") results.splice(index, 1);
      if (mutation === "skipped") results[index].status = "pending";
      if (mutation === "renamed") results[index].title += " (renamed)";
      if (mutation === "duplicate") results.push({ ...results[index] });
      assert.notEqual(check(value).status, 0, `${mutation}: ${titles[index]}`);
    }
  }
});

test("rejects malformed, failed, or wrong-file reports", () => {
  const wrongFile = report();
  wrongFile.testResults[0].name += ".bak";
  const failed = report();
  failed.success = false;
  const noResults = report();
  noResults.testResults[0].assertionResults = null;
  const noPassing = report();
  noPassing.numPassedTests = 0;
  for (const value of ["{", {}, wrongFile, failed, noResults, noPassing]) {
    assert.notEqual(check(value).status, 0);
  }
});
