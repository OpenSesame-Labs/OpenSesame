import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  miseCacheDisabledForWorkflow,
  workflowsWithMiseCacheDisabled,
} from "./ci-mise-cache-policy.mjs";

const workflowDir = join(import.meta.dirname, "../../.github/workflows");
/** actions/cache v6.1.0. Restore and save use the same commit. */
const cachePin = "55cc8345863c7cc4c66a329aec7e433d2d1c52a9";
const cacheUse =
  /uses:\s+actions\/cache(?:\/(?:restore|save))?@([0-9a-f]{40})/gu;

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
  assert.ok(disabled.includes("cd-pwa.yml"));
  assert.ok(disabled.includes("cd-npm-cli.yml"));
  assert.ok(!disabled.includes("ci.yml"));
  assert.ok(!disabled.includes("cd-npm-publish-proof.yml"));
});

const nodeMiseRestoreKey =
  "key: mise-v2-${{ runner.os }}-node-lock-${{ hashFiles('mise.toml', 'mise.lock') }}";
const goMiseRestoreKey =
  "key: mise-v2-${{ runner.os }}-go-lock-${{ hashFiles('mise.toml', 'mise.lock') }}";

function assertSecurityMiseRestore(text) {
  const name = "security.yml";
  const steps = text.split(/\n {6}- /u);
  const tools = [];
  for (const step of steps) {
    if (!step.includes("actions/cache")) continue;
    const tool = step.includes(goMiseRestoreKey)
      ? "go"
      : step.includes(nodeMiseRestoreKey)
        ? "node"
        : "";
    assert.ok(tool === "node" || tool === "go", name);
    tools.push(tool);
    assert.ok(
      step.includes(`uses: actions/cache/restore@${cachePin} # v6.1.0\n`),
      name,
    );
    assert.ok(step.includes("path: ~/.local/share/mise\n"), name);
    assert.ok(
      step.includes(`mise-v2-\${{ runner.os }}-seed-main-${tool}-\n`),
      name,
    );
    assert.ok(step.includes("mise-v1-linux-"), name);
    const other = tool === "node" ? "go" : "node";
    assert.equal(step.includes(`-seed-main-${other}-`), false, name);
    assert.equal(step.includes("actions/cache/save@"), false, name);
  }
  assert.deepEqual(tools.sort(), ["go", "node"], name);
  assert.equal(text.includes("actions/cache/save@"), false, name);
  assert.doesNotMatch(text, /uses:\s+actions\/cache@/u, name);
  assert.doesNotMatch(text, /^[ \t]+cache:[ \t]+true[ \t]*$/mu, name);
}

test("privileged workflows do not restore or save Actions caches", () => {
  const disabled = workflowsWithMiseCacheDisabled();
  assert.ok(disabled.length > 0);
  for (const name of disabled) {
    const text = readFileSync(join(workflowDir, name), "utf8");
    assert.equal(cacheUse.test(text), false, name);
    cacheUse.lastIndex = 0;
    assert.doesNotMatch(text, /^[ \t]+cache:[ \t]+true[ \t]*$/mu, name);
  }
});

test("security monitoring restores the mise tool cache and does not save it", () => {
  const text = readFileSync(join(workflowDir, "security.yml"), "utf8");
  assert.equal(miseCacheDisabledForWorkflow("security.yml"), false);
  assert.ok(text.includes(nodeMiseRestoreKey));
  assert.ok(text.includes(goMiseRestoreKey));
  assertSecurityMiseRestore(text);
});

test("actions/cache and actions/cache/restore stay on the repo pin", () => {
  const names = readdirSync(workflowDir).filter((name) =>
    name.endsWith(".yml"),
  );
  let seen = 0;
  for (const name of names) {
    const text = readFileSync(join(workflowDir, name), "utf8");
    for (const match of text.matchAll(cacheUse)) {
      seen += 1;
      assert.equal(match[1], cachePin, `${name} ${match[0]}`);
    }
  }
  assert.ok(seen > 0);
});
