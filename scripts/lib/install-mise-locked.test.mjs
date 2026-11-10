import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

function dockerfileArg(text, name) {
  const match = text.match(new RegExp(`^ARG ${name}=(\\S+)$`, "m"));
  assert.ok(match, name);
  return match[1];
}

function pin(text, name) {
  const match = text.match(new RegExp(`^${name}=(\\S+)$`, "m"));
  assert.ok(match, name);
  return match[1];
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

describe("locked mise bootstrap", () => {
  it("pins match the devcontainer image", () => {
    const pins = read(pinsRel);
    // .cursor/Dockerfile left this repo with the AI-harness dotfiles (#2538).
    const devcontainer = read(".devcontainer/Dockerfile");
    for (const name of [
      "MISE_VERSION",
      "MISE_SHA256_LINUX_X64",
      "MISE_SHA256_LINUX_ARM64",
    ]) {
      const value = pin(pins, name);
      assert.equal(dockerfileArg(devcontainer, name), value, name);
    }
    assert.match(pin(pins, "MISE_VERSION"), /^\d+\.\d+\.\d+$/u);
    assert.match(pin(pins, "MISE_SHA256_LINUX_X64"), /^[a-f0-9]{64}$/u);
    assert.match(pin(pins, "MISE_SHA256_LINUX_ARM64"), /^[a-f0-9]{64}$/u);
    assert.notEqual(
      pin(pins, "MISE_SHA256_LINUX_X64"),
      pin(pins, "MISE_SHA256_LINUX_ARM64"),
    );
  });

  it("installs the pinned tarball and locked tools", () => {
    const script = read(scriptRel);
    assert.match(script, /set -euo pipefail/u);
    assert.match(script, /sha256sum -c --strict/u);
    assert.match(script, /install --locked "\$@"/u);
    assert.match(script, /source "\$\{script_dir\}\/mise-pins\.sh"/u);
    assert.match(
      script,
      /https:\/\/github\.com\/jdx\/mise\/releases\/download\/v\$\{MISE_VERSION\}\/\$\{archive\}/u,
    );
    assert.match(
      script,
      /mise-v\$\{MISE_VERSION\}-\$\{mise_target\}\.tar\.gz/u,
    );
    assert.match(script, /--retry 5 --retry-delay 2/u);
    assert.doesNotMatch(
      script,
      /jdx\/mise-action|packslip|tar\.zst|api\.github\.com/u,
    );
    assert.doesNotMatch(script, /curl[^\n]*\|\s*(?:ba)?sh/u);
    const syntax = spawnSync("bash", ["-n", join(root, scriptRel)], {
      encoding: "utf8",
    });
    assert.equal(syntax.status, 0, syntax.stderr);
    const pinsSyntax = spawnSync("bash", ["-n", join(root, pinsRel)], {
      encoding: "utf8",
    });
    assert.equal(pinsSyntax.status, 0, pinsSyntax.stderr);
  });

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
