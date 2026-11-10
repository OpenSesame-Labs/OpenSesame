import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import * as nodeTest from "node:test";
import { fileURLToPath } from "node:url";
import { readString } from "./json-boundary.mjs";
import { pathCoveredBySparseCheckout } from "./workflow-script-paths.mjs";

const { describe, it } =
  process.env.VITEST === "true" ? await import("vitest") : nodeTest;

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const workflowDir = join(root, ".github/workflows");
const { parse } = createRequire(import.meta.url)("yaml");

const scriptRel = "scripts/lib/install-mise-locked.sh";
const pinsRel = "scripts/lib/mise-pins.sh";
const nodeBootstrap = "bash scripts/lib/install-mise-locked.sh node@24";
const hurlBootstrap =
  "bash scripts/lib/install-mise-locked.sh node@24 hurl@8.1.0";
const cachePin = "55cc8345863c7cc4c66a329aec7e433d2d1c52a9";
const primaryKey =
  "mise-v2-${{ runner.os }}-node-lock-${{ hashFiles('mise.toml', 'mise.lock') }}";
const seedKey = "mise-v2-${{ runner.os }}-seed-main-node-";
const legacyKey = "mise-v1-linux-";
const compileIf = "steps.ci_full_profile_dist.outcome != 'success'";
const runnerNode = "node scripts/release/cd-resolve-main-ci-run.mjs";

function read(rel) {
  return readFileSync(join(root, rel), "utf8");
}

function runOf(step) {
  return readString(step?.run) ?? "";
}

function needsToolchain(step) {
  const uses = readString(step?.uses) ?? "";
  if (uses.includes("publish-npm-package")) return true;
  const run = runOf(step);
  if (run.trim() === nodeBootstrap || run.trim() === hurlBootstrap) {
    return false;
  }
  return /\b(?:node|npm|hurl)\s+\S/u.test(run);
}

function sparsePatterns(job) {
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  for (const step of steps) {
    const uses = readString(step?.uses) ?? "";
    if (!uses.startsWith("actions/checkout@")) continue;
    const block = readString(step.with?.["sparse-checkout"]);
    if (block === undefined) return [];
    return block
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
  }
  return [];
}

function expectedBootstrap(name, id) {
  if (name === "cd-pwa.yml" && id === "preview_smoke") return hurlBootstrap;
  return nodeBootstrap;
}

function assertRestore(step, id) {
  const uses = readString(step?.uses) ?? "";
  assert.equal(uses, `actions/cache/restore@${cachePin}`, id);
  assert.equal(step.with?.path, "~/.local/share/mise", id);
  assert.equal(step.with?.key, primaryKey, id);
  const restoreKeys = readString(step.with?.["restore-keys"]) ?? "";
  assert.ok(restoreKeys.includes(seedKey), id);
  assert.ok(restoreKeys.includes(legacyKey), id);
  assert.equal(step.uses?.includes("actions/cache/save@"), false, id);
}

/** Where a job's first checkout, its cache restore, bootstrap and tool steps sit. */
function stepPositions(steps) {
  let checkoutAt = -1;
  let restoreAt = -1;
  let bootAt = -1;
  const toolAt = [];
  steps.forEach((step, index) => {
    const uses = readString(step?.uses) ?? "";
    const run = runOf(step).trim();
    if (uses.startsWith("actions/checkout@") && checkoutAt < 0) {
      checkoutAt = index;
    }
    if (uses.startsWith("actions/cache/restore@")) restoreAt = index;
    if (run === nodeBootstrap || run === hurlBootstrap) bootAt = index;
    if (needsToolchain(step)) toolAt.push(index);
  });
  return { checkoutAt, restoreAt, bootAt, toolAt };
}

/** A sparse checkout must still carry the installer, its pins and the mise files. */
function assertSparseCheckoutCoversInstaller(job, label) {
  const patterns = sparsePatterns(job);
  assert.equal(pathCoveredBySparseCheckout(scriptRel, patterns), true, label);
  assert.equal(pathCoveredBySparseCheckout(pinsRel, patterns), true, label);
  if (patterns.length > 0) {
    assert.ok(patterns.includes("/mise.toml"), label);
    assert.ok(
      patterns.includes("mise.lock") || patterns.includes("/mise.lock"),
      label,
    );
  }
}

/** Restoring the cache needs actions: read, on the job or on the workflow. */
function assertActionsRead(doc, job, label) {
  if (job.permissions !== undefined) {
    assert.equal(job.permissions.actions, "read", label);
  } else {
    assert.equal(doc.permissions?.actions, "read", label);
  }
}

/** Tools run after the bootstrap, except the resolver that runs on the runner's Node. */
function assertToolsFollowBootstrap({
  name,
  id,
  label,
  steps,
  bootAt,
  toolAt,
}) {
  for (const index of toolAt) {
    const run = runOf(steps[index]).trim();
    if (
      name === "cd-pwa.yml" &&
      id === "build_full_profile" &&
      run === runnerNode
    ) {
      assert.ok(index < bootAt, `${label} resolver must stay ahead of mise`);
      assert.equal(steps[index].if, undefined, label);
      continue;
    }
    assert.ok(index > bootAt, `${label} runs tools before locked mise`);
  }
}

/** Only the full-profile build skips restore and bootstrap when CI's dist is reused. */
function assertBootstrapCondition({
  name,
  id,
  label,
  steps,
  restoreAt,
  bootAt,
}) {
  if (name === "cd-pwa.yml" && id === "build_full_profile") {
    assert.equal(steps[restoreAt].if, compileIf, label);
    assert.equal(steps[bootAt].if, compileIf, label);
  } else {
    assert.equal(steps[restoreAt].if, undefined, label);
    assert.equal(steps[bootAt].if, undefined, label);
  }
}

/** One job: no tools means no bootstrap; otherwise checkout, restore, bootstrap, tools. */
function assertJobBootstrapsLockedMise({ doc, name, id, job }) {
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  const label = `${name}:${id}`;
  const { checkoutAt, restoreAt, bootAt, toolAt } = stepPositions(steps);
  if (toolAt.length === 0) {
    assert.equal(restoreAt, -1, `${label} restores without tools`);
    assert.equal(bootAt, -1, `${label} bootstraps without tools`);
    return;
  }
  assert.ok(checkoutAt >= 0, label);
  assert.ok(restoreAt > checkoutAt, `${label} restores after checkout`);
  assert.ok(bootAt > restoreAt, `${label} bootstraps after restore`);
  assert.equal(runOf(steps[bootAt]).trim(), expectedBootstrap(name, id), label);
  assertRestore(steps[restoreAt], label);
  assertSparseCheckoutCoversInstaller(job, label);
  assertActionsRead(doc, job, label);
  assertToolsFollowBootstrap({ name, id, label, steps, bootAt, toolAt });
  assertBootstrapCondition({ name, id, label, steps, restoreAt, bootAt });
}

describe("locked mise bootstrap: PWA CD", () => {
  it("covers PWA CD jobs and does not save the cache", () => {
    const ci = read(".github/workflows/ci.yml");
    assert.ok(ci.includes(`key: ${primaryKey}`));
    assert.ok(ci.includes(seedKey));
    assert.ok(ci.includes(legacyKey));
    const required = ["cd-pwa.yml", "cd-pwa-profile-proof.yml"];
    const present = readdirSync(workflowDir).filter((name) =>
      read(join(".github/workflows", name)).includes(
        "bash scripts/lib/install-mise-locked.sh",
      ),
    );
    for (const name of required) assert.ok(present.includes(name), name);
    // Only this test's workflows: GHCR CD has its own coverage test and its own
    // invocation (install-mise-locked.test.mjs).
    for (const name of required) {
      const text = read(join(".github/workflows", name));
      assert.doesNotMatch(text, /jdx\/mise-action/u, name);
      assert.doesNotMatch(text, /actions\/cache\/save@/u, name);
      assert.doesNotMatch(text, /uses:\s+actions\/cache@/u, name);
      assert.doesNotMatch(text, /^[ \t]+cache:[ \t]+true[ \t]*$/mu, name);
      const doc = parse(text);
      const jobs = doc.jobs ?? {};
      const ids = Object.keys(jobs);
      assert.ok(ids.length > 0, name);
      for (const id of ids) {
        assertJobBootstrapsLockedMise({ doc, name, id, job: jobs[id] });
      }
      if (name === "cd-pwa.yml") {
        assert.equal(jobs.promotion_failed?.permissions?.actions, "read");
        assert.equal(jobs.promotion_failed?.permissions?.contents, "write");
        assert.equal(jobs.deploy?.permissions?.actions, undefined);
      }
    }
  });
});
