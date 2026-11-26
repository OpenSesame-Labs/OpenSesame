import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as nodeTest from "node:test";
import {
  SPARSE_SCRIPT_GUARD_WORKFLOWS,
  analyzeWorkflow,
  assertWorkflowScriptPaths,
  pathCoveredBySparseCheckout,
  repoRootFromHere,
  scriptPathsInText,
} from "./workflow-script-paths.mjs";

// quality:test loads this file with Vitest. The CD contract also runs under node --test.
const { test } =
  process.env.VITEST === "true" ? await import("vitest") : nodeTest;

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
  const start = content.indexOf("\n  preview_smoke:\n");
  const end = content.indexOf("\n  production:\n", start);
  assert.ok(start > 0 && end > start);
  const smoke = content.slice(start, end);
  const checkoutAt = smoke.indexOf("          sparse-checkout: |\n");
  assert.ok(checkoutAt >= 0);
  const listStart = checkoutAt + "          sparse-checkout: |\n".length;
  const listEnd = smoke.slice(listStart).search(/\n(?! {10,}\S)/);
  assert.ok(listEnd > 0);
  const sparseLine = "            scripts/ci\n";
  const lineAt = smoke
    .slice(listStart, listStart + listEnd)
    .indexOf(sparseLine);
  assert.ok(lineAt >= 0);
  // preview_dependency_integrity lists the same path earlier in the file.
  // Drop scripts/ci from this job's sparse-checkout only.
  const removeAt = start + listStart + lineAt;
  const broken =
    content.slice(0, removeAt) + content.slice(removeAt + sparseLine.length);
  const analyzed = analyzeWorkflow(broken, {
    workflowPath: ".github/workflows/cd-pwa.yml",
  });
  const preview = analyzed.filter((entry) => entry.jobId === "preview_smoke");
  assert.ok(
    preview
      .map((entry) => entry.script)
      .includes("scripts/ci/ensure-chrome-headless-shell.mjs"),
  );
  assert.equal(
    pathCoveredBySparseCheckout(
      "scripts/ci/ensure-chrome-headless-shell.mjs",
      preview.find((entry) =>
        entry.script.endsWith("ensure-chrome-headless-shell.mjs"),
      )?.sparse ?? [],
    ),
    false,
  );
  const integrityStart = content.indexOf("\n  preview_dependency_integrity:\n");
  assert.ok(integrityStart > 0 && integrityStart < start);
  assert.equal(broken.slice(integrityStart, start).includes(sparseLine), true);
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
