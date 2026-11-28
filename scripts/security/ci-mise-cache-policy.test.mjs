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
    "pr-rust-security-evidence.yml",
  ]) {
    assert.equal(miseCacheDisabledForWorkflow(name), true, name);
  }
});

test("privileged workflow list matches workflow_call and release filenames", () => {
  const disabled = workflowsWithMiseCacheDisabled();
  assert.ok(disabled.includes("ci-prerelease-checks.yml"));
  assert.ok(disabled.includes("cd-pwa.yml"));
  assert.ok(disabled.includes("cd-npm-cli.yml"));
  assert.ok(disabled.includes("cd-ghcr-publish.yml"));
  assert.ok(!disabled.includes("ci.yml"));
  assert.ok(!disabled.includes("cd-npm-publish-proof.yml"));
});

const nodeMiseRestoreKey =
  "key: mise-v2-${{ runner.os }}-node-lock-${{ hashFiles('mise.toml', 'mise.lock') }}";
const rustMiseRestoreKey =
  "key: mise-v2-${{ runner.os }}-rust-lock-${{ hashFiles('mise.toml', 'mise.lock') }}";

// Workflows that restore the trunk mise tool cache read-only, and the tools
// each restores. GHCR restores Node and Rust once each; PWA CD and the npm CLI
// restore Node in every job that needs it; the stranded-deploy dispatcher
// (push to main only) restores Node once.
const readOnlyMiseRestore = new Map([
  ["cd-ghcr-publish.yml", { tools: ["node", "rust"], once: true }],
  ["cd-npm-cli.yml", { tools: ["node"], once: false }],
  ["cd-pwa.yml", { tools: ["node"], once: false }],
  ["cd-pwa-profile-proof.yml", { tools: ["node"], once: false }],
  ["cd-pwa-stranded-dispatch.yml", { tools: ["node"], once: true }],
]);

function assertReadOnlyMiseRestore(name, text) {
  const expected = readOnlyMiseRestore.get(name);
  const steps = text.split(/\n {6}- /u);
  const tools = [];
  for (const step of steps) {
    if (!step.includes("actions/cache")) continue;
    const tool = step.includes(rustMiseRestoreKey)
      ? "rust"
      : step.includes(nodeMiseRestoreKey)
        ? "node"
        : "";
    assert.ok(tool === "node" || tool === "rust", name);
    assert.ok(expected.tools.includes(tool), `${name} restores ${tool}`);
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
    const other = tool === "node" ? "rust" : "node";
    assert.equal(step.includes(`-seed-main-${other}-`), false, name);
    assert.equal(step.includes("actions/cache/save@"), false, name);
  }
  assert.ok(tools.length > 0, name);
  if (expected.once) {
    assert.deepEqual(tools.sort(), [...expected.tools].sort(), name);
  } else {
    assert.deepEqual(
      [...new Set(tools)].sort(),
      [...expected.tools].sort(),
      name,
    );
  }
  assert.equal(text.includes("actions/cache/save@"), false, name);
  assert.doesNotMatch(text, /uses:\s+actions\/cache@/u, name);
}

// codeql.yml is reusable (release qualification) and also the scheduled
// monitor. Its one reviewed Actions cache is the Gradle module cache: restored
// on every java-kotlin run and saved only by a monitoring run of main, never
// for a candidate. ci-trusted-cache.test.mjs asserts the full step shape.
const gradleCachePath = "path: ~/.gradle/caches/modules-2\n";
const gradleSaveGuard =
  "!inputs.source_sha && github.ref == 'refs/heads/main' && (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch')";

const nativeDistributionPath =
  "path: .cache/pwa-tailscale-native-http/distributions\n";
const nativeDistributionKey =
  "key: pwa-native-distribution-${{ hashFiles('tools/pwa-tailscale-native-http/source.json', 'apps/pages/src/lib/capabilities/tailscale-artifacts.json') }}";
const ghcrNativeSaveIf =
  "if: github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'schedule' || github.event_name == 'workflow_dispatch') && steps.native_cache.outputs.cache-hit != 'true'\n";

function workflowSteps(text) {
  return text.split(/(?=\n {6}- )/u);
}

function nativeDistributionSteps(steps) {
  return steps.filter(
    (step) =>
      step.includes("actions/cache") && step.includes(nativeDistributionPath),
  );
}

function assertGhcrNativeDistribution(native) {
  assert.equal(native.length, 2, "cd-ghcr-publish.yml");
  const [restore, save] = native;
  assert.ok(
    restore.includes(`uses: actions/cache/restore@${cachePin} # v6.1.0\n`),
    "cd-ghcr-publish.yml",
  );
  assert.ok(restore.includes("id: native_cache\n"), "cd-ghcr-publish.yml");
  assert.ok(
    restore.includes("name: Restore the pinned native PWA distribution\n"),
  );
  assert.ok(restore.includes(nativeDistributionKey), "cd-ghcr-publish.yml");
  assert.equal(restore.includes("restore-keys:"), false, "cd-ghcr-publish.yml");
  assert.ok(save.includes(ghcrNativeSaveIf), "cd-ghcr-publish.yml");
  assert.ok(
    save.includes(`uses: actions/cache/save@${cachePin} # v6.1.0\n`),
    "cd-ghcr-publish.yml",
  );
  assert.ok(
    save.includes("name: Save the pinned native PWA distribution\n"),
    "cd-ghcr-publish.yml",
  );
  assert.ok(save.includes(nativeDistributionKey), "cd-ghcr-publish.yml");
  assert.equal(save.includes("restore-keys:"), false, "cd-ghcr-publish.yml");
  assert.equal(
    save.includes("continue-on-error"),
    false,
    "cd-ghcr-publish.yml",
  );
}

function assertPwaNativeDistribution(native) {
  assert.equal(native.length, 2, "cd-pwa.yml");
  assert.ok(
    native[0].includes("if: steps.ci_full_profile_dist.outcome != 'success'\n"),
    "cd-pwa.yml",
  );
  assert.equal(native[1].includes("\n        if:"), false, "cd-pwa.yml");
  for (const step of native) {
    assert.ok(
      step.includes(`uses: actions/cache@${cachePin} # v6.1.0\n`),
      "cd-pwa.yml",
    );
    assert.ok(
      step.includes("name: Cache the pinned native PWA distribution\n"),
      "cd-pwa.yml",
    );
    assert.ok(step.includes(nativeDistributionKey), "cd-pwa.yml");
    assert.equal(step.includes("restore-keys:"), false, "cd-pwa.yml");
    assert.equal(step.includes("actions/cache/save@"), false, "cd-pwa.yml");
    assert.equal(step.includes("actions/cache/restore@"), false, "cd-pwa.yml");
  }
}

/** Drop the reviewed native distribution cache before the mise read-only check. */
function withoutReviewedNativeDistribution(name, text) {
  if (name !== "cd-ghcr-publish.yml" && name !== "cd-pwa.yml") return text;
  const steps = workflowSteps(text);
  const native = nativeDistributionSteps(steps);
  if (name === "cd-ghcr-publish.yml") assertGhcrNativeDistribution(native);
  else assertPwaNativeDistribution(native);
  return steps.filter((step) => !native.includes(step)).join("");
}

function withoutReviewedGradleCache(name, text) {
  if (name !== "codeql.yml") return text;
  const steps = text.split(/(?=\n {6}- )/u);
  const gradle = steps.filter((step) => step.includes(gradleCachePath));
  assert.equal(gradle.length, 2, name);
  const [restore, save] = gradle;
  assert.ok(
    restore.includes(`uses: actions/cache/restore@${cachePin} # v6.1.0\n`),
    name,
  );
  assert.ok(save.includes(`uses: actions/cache/save@${cachePin} # v6.1.0\n`));
  assert.ok(save.includes(gradleSaveGuard), name);
  return steps.filter((step) => !gradle.includes(step)).join("");
}

test("privileged workflows do not save Actions caches", () => {
  const disabled = workflowsWithMiseCacheDisabled();
  assert.ok(disabled.length > 0);
  const ci = readFileSync(join(workflowDir, "ci.yml"), "utf8");
  assert.ok(ci.includes(nodeMiseRestoreKey));
  assert.ok(ci.includes(rustMiseRestoreKey));
  assert.ok(disabled.includes("codeql.yml"));
  for (const name of disabled) {
    const text = withoutReviewedNativeDistribution(
      name,
      withoutReviewedGradleCache(
        name,
        readFileSync(join(workflowDir, name), "utf8"),
      ),
    );
    assert.equal(text.includes("actions/cache/save@"), false, name);
    assert.doesNotMatch(text, /uses:\s+actions\/cache@/u, name);
    assert.doesNotMatch(text, /^[ \t]+cache:[ \t]+true[ \t]*$/mu, name);
    if (readOnlyMiseRestore.has(name)) {
      assertReadOnlyMiseRestore(name, text);
      continue;
    }
    assert.equal(cacheUse.test(text), false, name);
    cacheUse.lastIndex = 0;
  }
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
