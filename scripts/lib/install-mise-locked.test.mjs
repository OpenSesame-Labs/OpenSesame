import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
const nodeBootstrap = "bash scripts/lib/install-mise-locked.sh node";
const rustBootstrap = "bash scripts/lib/install-mise-locked.sh rust";
const cachePin = "55cc8345863c7cc4c66a329aec7e433d2d1c52a9";
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

function primaryKey(tool) {
  return `mise-v2-\${{ runner.os }}-${tool}-lock-\${{ hashFiles('mise.toml', 'mise.lock') }}`;
}

function seedKey(tool) {
  return `mise-v2-\${{ runner.os }}-seed-main-${tool}-`;
}

function needsNode(step) {
  return /\bnpm\s+(?:ci|run|exec)\b/u.test(runOf(step));
}

function needsRust(step) {
  const uses = readString(step?.uses) ?? "";
  if (uses.startsWith("Swatinem/rust-cache@")) return true;
  return /\b(?:cargo|rustup)\s+/u.test(runOf(step));
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

function assertRestore(step, tool, id) {
  const uses = readString(step?.uses) ?? "";
  assert.equal(uses, `actions/cache/restore@${cachePin}`, id);
  assert.equal(step.with?.path, "~/.local/share/mise", id);
  assert.equal(step.with?.key, primaryKey(tool), id);
  const restoreKeys = readString(step.with?.["restore-keys"]) ?? "";
  assert.ok(restoreKeys.includes(seedKey(tool)), id);
  assert.ok(restoreKeys.includes(legacyKey), id);
  assert.equal(uses.includes("actions/cache/save@"), false, id);
}

describe("locked mise bootstrap", () => {
  it("pins match the Cursor and devcontainer images", () => {
    const pins = read(pinsRel);
    const cloud = read(".cursor/Dockerfile");
    const devcontainer = read(".devcontainer/Dockerfile");
    for (const name of [
      "MISE_VERSION",
      "MISE_SHA256_LINUX_X64",
      "MISE_SHA256_LINUX_ARM64",
    ]) {
      const value = pin(pins, name);
      assert.equal(dockerfileArg(cloud, name), value, name);
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

  it("covers GHCR CD toolchain jobs and does not save the cache", () => {
    const ci = read(".github/workflows/ci.yml");
    assert.ok(ci.includes(`key: ${primaryKey("node")}`));
    assert.ok(ci.includes(`key: ${primaryKey("rust")}`));
    assert.ok(ci.includes(seedKey("node")));
    assert.ok(ci.includes(seedKey("rust")));
    assert.ok(ci.includes(legacyKey));
    const required = ["cd-ghcr-publish.yml"];
    const present = readdirSync(workflowDir).filter((name) =>
      read(join(".github/workflows", name)).includes(
        "bash scripts/lib/install-mise-locked.sh",
      ),
    );
    for (const name of required) assert.ok(present.includes(name), name);
    for (const name of present) {
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
        const job = jobs[id];
        const steps = Array.isArray(job?.steps) ? job.steps : [];
        const label = `${name}:${id}`;
        let checkoutAt = -1;
        let restoreAt = -1;
        let bootAt = -1;
        let nodeAt = -1;
        let rustAt = -1;
        steps.forEach((step, index) => {
          const uses = readString(step?.uses) ?? "";
          const run = runOf(step).trim();
          if (uses.startsWith("actions/checkout@") && checkoutAt < 0) {
            checkoutAt = index;
          }
          if (uses.startsWith("actions/cache/restore@")) restoreAt = index;
          if (run === nodeBootstrap || run === rustBootstrap) bootAt = index;
          if (nodeAt < 0 && run !== nodeBootstrap && needsNode(step)) {
            nodeAt = index;
          }
          if (rustAt < 0 && run !== rustBootstrap && needsRust(step)) {
            rustAt = index;
          }
        });
        const tool = nodeAt >= 0 ? "node" : rustAt >= 0 ? "rust" : "";
        assert.equal(nodeAt >= 0 && rustAt >= 0, false, label);
        if (tool === "") {
          assert.equal(restoreAt, -1, `${label} restores without tools`);
          assert.equal(bootAt, -1, `${label} bootstraps without tools`);
          continue;
        }
        assert.ok(checkoutAt >= 0, label);
        assert.ok(restoreAt > checkoutAt, `${label} restores after checkout`);
        assert.ok(bootAt > restoreAt, `${label} bootstraps after restore`);
        const needAt = tool === "node" ? nodeAt : rustAt;
        assert.ok(needAt > bootAt, `${label} runs tools before locked mise`);
        assert.equal(
          runOf(steps[bootAt]).trim(),
          tool === "node" ? nodeBootstrap : rustBootstrap,
          label,
        );
        assertRestore(steps[restoreAt], tool, label);
        assert.equal(steps[restoreAt].if, undefined, label);
        assert.equal(steps[bootAt].if, undefined, label);
        const patterns = sparsePatterns(job);
        assert.equal(
          pathCoveredBySparseCheckout(scriptRel, patterns),
          true,
          label,
        );
        assert.equal(
          pathCoveredBySparseCheckout(pinsRel, patterns),
          true,
          label,
        );
        if (patterns.length > 0) {
          assert.ok(patterns.includes("/mise.toml"), label);
          assert.ok(patterns.includes("/mise.lock"), label);
        }
        if (job.permissions === undefined) {
          assert.equal(doc.permissions?.actions, "read", label);
        } else if (id === "opensesame-amd64-rust") {
          assert.equal(job.permissions.actions, "write", label);
          assert.equal(job.permissions.contents, "read", label);
        } else {
          assert.equal(job.permissions.actions, "read", label);
        }
      }
    }
  });
});
