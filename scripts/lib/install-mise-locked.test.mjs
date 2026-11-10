import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
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

// Every workflow that runs the installer, mapped to the test file that checks
// its jobs in detail. A workflow that adopts the installer without an entry
// here fails, so it cannot go uncovered.
const coveredBy = new Map([
  ["cd-ghcr-publish.yml", "install-mise-locked.test.mjs"],
  ["cd-npm-cli.yml", "install-mise-locked.npm-cli.test.mjs"],
  ["cd-pwa.yml", "install-mise-locked.pwa.test.mjs"],
  ["cd-pwa-profile-proof.yml", "install-mise-locked.pwa.test.mjs"],
]);

function installerWorkflows() {
  return readdirSync(workflowDir).filter((name) =>
    read(join(".github/workflows", name)).includes(
      "bash scripts/lib/install-mise-locked.sh",
    ),
  );
}

describe("locked mise bootstrap", () => {
  it("every workflow that runs the installer has a coverage test", () => {
    const present = installerWorkflows();
    assert.ok(present.length > 0);
    for (const name of present) {
      assert.ok(coveredBy.has(name), `${name} has no coverage test`);
      const text = read(join(".github/workflows", name));
      assert.doesNotMatch(text, /jdx\/mise-action/u, name);
      assert.doesNotMatch(text, /actions\/cache\/save@/u, name);
      assert.doesNotMatch(text, /uses:\s+actions\/cache@/u, name);
      assert.doesNotMatch(text, /^[ \t]+cache:[ \t]+true[ \t]*$/mu, name);
    }
    for (const [name, file] of coveredBy) {
      assert.ok(present.includes(name), `${name} no longer runs the installer`);
      assert.ok(
        read(join("scripts/lib", file)).includes(name),
        `${file}: ${name}`,
      );
    }
  });

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

  it("exports the mise.toml environment to later steps, without PATH", () => {
    // Run the real script against a stub mise and a stub curl. mise-action
    // exported the [env] table to GITHUB_ENV; cd-ghcr-publish.yml uploads from
    // ${{ env.CARGO_TARGET_DIR }}, which is empty if the installer does not.
    const work = mkdtempSync(join(tmpdir(), "mise-locked-"));
    try {
      const lib = join(work, "repo/scripts/lib");
      const bin = join(work, "bin");
      const pack = join(work, "pack/mise/bin");
      for (const dir of [lib, bin, pack, join(work, "home")])
        mkdirSync(dir, { recursive: true });
      cpSync(join(root, scriptRel), join(lib, "install-mise-locked.sh"));
      writeFileSync(join(work, "repo/mise.toml"), "");
      writeFileSync(join(work, "repo/mise.lock"), "");
      writeFileSync(
        join(pack, "mise"),
        [
          "#!/usr/bin/env bash",
          'if [[ "$1" == env ]]; then',
          "  printf '%s\\n' 'CARGO_TARGET_DIR=/cache/cargo-target' 'RUSTUP_TOOLCHAIN=1.97.1' 'PATH=/stub/shims:/usr/bin'",
          "fi",
          "exit 0",
          "",
        ].join("\n"),
      );
      chmodSync(join(pack, "mise"), 0o755);
      const tarball = join(work, "mise.tar.gz");
      const tar = spawnSync(
        "tar",
        ["-czf", tarball, "-C", join(work, "pack"), "mise/bin/mise"],
        { encoding: "utf8" },
      );
      assert.equal(tar.status, 0, tar.stderr);
      const sum = spawnSync("sha256sum", [tarball], { encoding: "utf8" });
      assert.equal(sum.status, 0, sum.stderr);
      const digest = sum.stdout.split(" ")[0];
      writeFileSync(
        join(lib, "mise-pins.sh"),
        `MISE_VERSION=0.0.0\nMISE_SHA256_LINUX_X64=${digest}\nMISE_SHA256_LINUX_ARM64=${digest}\n`,
      );
      // The stub serves the prepared tarball for whatever URL is requested.
      writeFileSync(
        join(bin, "curl"),
        [
          "#!/usr/bin/env bash",
          'out=""',
          "while [[ $# -gt 0 ]]; do",
          '  if [[ "$1" == --output ]]; then out="$2"; shift; fi',
          "  shift",
          "done",
          `cp ${JSON.stringify(tarball)} "$out"`,
          "",
        ].join("\n"),
      );
      chmodSync(join(bin, "curl"), 0o755);
      const githubEnv = join(work, "github-env");
      const githubPath = join(work, "github-path");
      writeFileSync(githubEnv, "");
      writeFileSync(githubPath, "");
      const run = spawnSync(
        "bash",
        [join(lib, "install-mise-locked.sh"), "rust"],
        {
          encoding: "utf8",
          env: {
            PATH: `${bin}:${process.env.PATH}`,
            HOME: join(work, "home"),
            GITHUB_WORKSPACE: join(work, "repo"),
            GITHUB_ENV: githubEnv,
            GITHUB_PATH: githubPath,
          },
        },
      );
      assert.equal(run.status, 0, run.stderr);
      const exported = readFileSync(githubEnv, "utf8").trim().split("\n");
      assert.ok(exported.includes("CARGO_TARGET_DIR=/cache/cargo-target"));
      assert.ok(exported.includes("RUSTUP_TOOLCHAIN=1.97.1"));
      assert.ok(exported.includes("MISE_YES=1"));
      assert.equal(
        exported.some((line) => line.startsWith("PATH=")),
        false,
      );
      assert.match(readFileSync(githubPath, "utf8"), /\.local\/bin\n/u);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
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
    const present = installerWorkflows();
    for (const name of required) assert.ok(present.includes(name), name);
    // Only this test's workflows: PWA CD has its own coverage test and its own
    // invocation (install-mise-locked.pwa.test.mjs).
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
