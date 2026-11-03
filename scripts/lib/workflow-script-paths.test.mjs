import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  SPARSE_SCRIPT_GUARD_WORKFLOWS,
  analyzeWorkflow,
  assertWorkflowScriptPaths,
  pathCoveredBySparseCheckout,
  repoRootFromHere,
  scriptPathsInText,
} from "./workflow-script-paths.mjs";

const root = repoRootFromHere();

test("pathCoveredBySparseCheckout accepts directory and file patterns", () => {
  assert.equal(
    pathCoveredBySparseCheckout("scripts/ci/ensure-chrome-headless-shell.mjs", [
      "scripts/ci",
    ]),
    true,
  );
  assert.equal(
    pathCoveredBySparseCheckout("scripts/ci/ensure-chrome-headless-shell.mjs", [
      "scripts/release",
      "scripts/lib",
    ]),
    false,
  );
});

test("preview_smoke at 0faec2e6 would fail the sparse guard", () => {
  const content = readFileSync(
    join(root, ".github/workflows/cd-pwa.yml"),
    "utf8",
  );
  const broken = content.replace("            scripts/ci\n", "");
  const previewScripts = analyzeWorkflow(broken, {
    workflowPath: ".github/workflows/cd-pwa.yml",
  })
    .filter((entry) => entry.jobId === "preview_smoke")
    .map((entry) => entry.script);
  assert.ok(
    previewScripts.includes("scripts/ci/ensure-chrome-headless-shell.mjs"),
  );
  assert.equal(
    pathCoveredBySparseCheckout(
      "scripts/ci/ensure-chrome-headless-shell.mjs",
      analyzeWorkflow(broken, {
        workflowPath: ".github/workflows/cd-pwa.yml",
      }).find((entry) => entry.jobId === "preview_smoke")?.sparse ?? [],
    ),
    false,
  );
});

test("every CD sparse-checkout workflow includes its node scripts", () => {
  for (const workflowPath of SPARSE_SCRIPT_GUARD_WORKFLOWS) {
    assertWorkflowScriptPaths(root, workflowPath);
  }
});

test("preview smoke checks out scripts/ci and requires chrome-headless-shell", () => {
  const content = readFileSync(
    join(root, ".github/workflows/cd-pwa.yml"),
    "utf8",
  );
  const preview = analyzeWorkflow(content, {
    workflowPath: ".github/workflows/cd-pwa.yml",
  }).filter((entry) => entry.jobId === "preview_smoke");
  const shell = preview.find((entry) =>
    entry.script.endsWith("ensure-chrome-headless-shell.mjs"),
  );
  assert.ok(shell);
  assert.equal(shell.sparse.includes("scripts/ci"), true);
  assert.equal(pathCoveredBySparseCheckout(shell.script, shell.sparse), true);
  const start = content.indexOf("\n  preview_smoke:\n");
  const end = content.indexOf("\n  production:\n");
  assert.ok(start > 0 && end > start);
  assert.match(
    content.slice(start, end),
    /CD_PWA_SMOKE_REQUIRE_HEADLESS_SHELL: "1"/,
  );
});

test("scriptPathsInText finds multiline shell invocations", () => {
  const text = `
    run: |
      path="$(node scripts/ci/ensure-chrome-headless-shell.mjs)"
  `;
  assert.deepEqual(scriptPathsInText(text), [
    "scripts/ci/ensure-chrome-headless-shell.mjs",
  ]);
});
