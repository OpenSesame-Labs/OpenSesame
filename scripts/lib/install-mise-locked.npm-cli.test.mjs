import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import * as nodeTest from "node:test";
import { fileURLToPath } from "node:url";
import { readString } from "./json-boundary.mjs";
import { pathCoveredBySparseCheckout } from "./workflow-script-paths.mjs";

const { describe, it } =
  process.env.VITEST === "true" ? await import("vitest") : nodeTest;

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const { parse } = createRequire(import.meta.url)("yaml");

const scriptRel = "scripts/lib/install-mise-locked.sh";
const pinsRel = "scripts/lib/mise-pins.sh";
const workflowRel = ".github/workflows/cd-npm-cli.yml";
const bootstrap = "bash scripts/lib/install-mise-locked.sh node@24";
const cachePin = "55cc8345863c7cc4c66a329aec7e433d2d1c52a9";
const primaryKey =
  "mise-v2-${{ runner.os }}-node-lock-${{ hashFiles('mise.toml', 'mise.lock') }}";
const seedKey = "mise-v2-${{ runner.os }}-seed-main-node-";
const legacyKey = "mise-v1-linux-";

function read(rel) {
  return readFileSync(join(root, rel), "utf8");
}

function runOf(step) {
  return readString(step?.run) ?? "";
}

function needsNode(step) {
  const uses = readString(step?.uses) ?? "";
  if (uses.includes("publish-npm-package")) return true;
  const run = runOf(step);
  return /\b(?:node|npm)\s+\S/u.test(run);
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

describe("locked mise bootstrap: npm CLI CD", () => {
  it("covers every cd-npm-cli job and does not save the cache", () => {
    const text = read(workflowRel);
    const ci = read(".github/workflows/ci.yml");
    assert.ok(ci.includes(`key: ${primaryKey}`));
    assert.ok(ci.includes(seedKey));
    assert.ok(ci.includes(legacyKey));
    assert.doesNotMatch(text, /jdx\/mise-action/u);
    assert.doesNotMatch(text, /actions\/cache\/save@/u);
    assert.doesNotMatch(text, /uses:\s+actions\/cache@/u);
    assert.doesNotMatch(text, /^[ \t]+cache:[ \t]+true[ \t]*$/mu);
    const jobs = parse(text).jobs ?? {};
    const ids = Object.keys(jobs);
    assert.ok(ids.length > 0);
    for (const id of ids) {
      const job = jobs[id];
      const steps = Array.isArray(job?.steps) ? job.steps : [];
      let checkoutAt = -1;
      let restoreAt = -1;
      let bootAt = -1;
      let nodeAt = -1;
      steps.forEach((step, index) => {
        const uses = readString(step?.uses) ?? "";
        const run = runOf(step).trim();
        if (uses.startsWith("actions/checkout@") && checkoutAt < 0) {
          checkoutAt = index;
        }
        if (uses.startsWith("actions/cache/restore@")) {
          restoreAt = index;
          assert.equal(uses, `actions/cache/restore@${cachePin}`, id);
          assert.equal(step.with?.path, "~/.local/share/mise", id);
          assert.equal(step.with?.key, primaryKey, id);
          const restoreKeys = readString(step.with?.["restore-keys"]) ?? "";
          assert.ok(restoreKeys.includes(seedKey), id);
          assert.ok(restoreKeys.includes(legacyKey), id);
        }
        if (run === bootstrap) bootAt = index;
        if (nodeAt < 0 && run !== bootstrap && needsNode(step)) nodeAt = index;
      });
      assert.ok(checkoutAt >= 0, id);
      assert.ok(restoreAt > checkoutAt, `${id} restores before checkout`);
      assert.ok(bootAt > restoreAt, `${id} installs before the cache restore`);
      assert.ok(nodeAt > bootAt, `${id} runs node before locked mise`);
      const patterns = sparsePatterns(job);
      assert.equal(pathCoveredBySparseCheckout(scriptRel, patterns), true, id);
      assert.equal(pathCoveredBySparseCheckout(pinsRel, patterns), true, id);
    }
    const failed = jobs.promotion_failed;
    assert.equal(failed?.permissions?.actions, "read");
    assert.equal(failed?.permissions?.contents, "write");
  });
});
