import assert from "node:assert/strict";
import { test } from "node:test";
import {
  miseCacheDisabledForWorkflow,
  workflowsWithMiseCacheDisabled,
} from "./ci-mise-cache-policy.mjs";

test("integration CI keeps mise cache enabled on trusted triggers", () => {
  assert.equal(miseCacheDisabledForWorkflow("ci.yml"), false);
  assert.equal(miseCacheDisabledForWorkflow("security.yml"), false);
});

test("candidate and release workflows disable mise cache", () => {
  for (const name of [
    "ci-prerelease-checks.yml",
    "candidate-build.yml",
    "release-publish.yml",
    "full-suite.yml",
  ]) {
    assert.equal(miseCacheDisabledForWorkflow(name), true, name);
  }
});

test("privileged workflow list matches workflow_call and release filenames", () => {
  const disabled = workflowsWithMiseCacheDisabled();
  assert.ok(disabled.includes("ci-prerelease-checks.yml"));
  assert.ok(!disabled.includes("ci.yml"));
});
