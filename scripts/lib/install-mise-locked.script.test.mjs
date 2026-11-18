// The installer script itself: its pins, what it exports to later steps and
// what it downloads. Which workflow jobs run it is install-mise-locked.test.mjs
// and its per-workflow siblings.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as nodeTest from "node:test";
import { fileURLToPath } from "node:url";

const { describe, it } =
  process.env.VITEST === "true" ? await import("vitest") : nodeTest;

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

const scriptRel = "scripts/lib/install-mise-locked.sh";
const pinsRel = "scripts/lib/mise-pins.sh";

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

/**
 * A throwaway checkout holding the real script, a stub mise packed as the
 * pinned tarball, and a stub curl that serves it.
 */
function prepareStubInstall(work) {
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
      "  printf '%s\\n' 'CARGO_TARGET_DIR=/cache/cargo-target' 'RUSTUP_TOOLCHAIN=1.99.0' 'PATH=/stub/shims:/usr/bin'",
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
  return { lib, bin, githubEnv, githubPath };
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

  it("exports the mise.toml environment to later steps, without PATH", () => {
    // Run the real script against a stub mise and a stub curl. mise-action
    // exported the [env] table to GITHUB_ENV; cd-ghcr-publish.yml uploads from
    // ${{ env.CARGO_TARGET_DIR }}, which is empty if the installer does not.
    const work = mkdtempSync(join(tmpdir(), "mise-locked-"));
    try {
      const { lib, bin, githubEnv, githubPath } = prepareStubInstall(work);
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
      assert.ok(exported.includes("RUSTUP_TOOLCHAIN=1.99.0"));
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
});
