import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  asBoolean,
  asString,
  asTable,
  parseToml,
  stringList,
} from "./mise-toml.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const lockPlatforms = [
  "linux-x64",
  "linux-arm64",
  "macos-arm64",
  "macos-x64",
  "windows-x64",
];

function readText(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

function sorted(values) {
  return [...values].sort();
}

test("mise.toml matches the Rust, Node, Go, Java, and cargo-ndk pins", () => {
  const mise = parseToml(readText("mise.toml"));
  const toolchain = parseToml(readText("rust-toolchain.toml"));
  const manifest = JSON.parse(readText("package.json"));
  const ci = readText(".github/workflows/ci-prerelease-checks.yml");
  const tools = asTable(mise.tools, "tools");
  const rust = asTable(tools.rust, "rust");
  const declared = asTable(toolchain.toolchain, "toolchain");

  assert.equal(
    asString(rust.version, "rust.version"),
    asString(declared.channel, "channel"),
  );
  assert.deepEqual(
    sorted(stringList(rust.components, "rust.components")),
    sorted([
      ...stringList(declared.components, "components"),
      "llvm-tools-preview",
    ]),
  );
  assert.match(
    readText("mise.lock"),
    /\[tools\.rust\.options\]\ncomponents = "clippy,llvm-tools-preview,rustfmt"\ntargets = "wasm32-unknown-unknown"\n/u,
  );
  assert.deepEqual(
    sorted(stringList(rust.targets, "rust.targets")),
    sorted(stringList(declared.targets, "targets")),
  );

  // mise.toml pins Node 24. package.json engines.node is ">=24" after the
  // npm workspaces migration. Turbo reads packageManager. The legacy
  // package manager stays out of mise.
  assert.equal(asString(tools.node, "node"), "24");
  assert.equal(manifest.engines.node, ">=24");
  assert.equal(manifest.packageManager, "npm@11.19.1");
  assert.equal(Object.hasOwn(tools, "pn" + "pm"), false);
  assert.ok(
    Array.isArray(manifest.workspaces) && manifest.workspaces.length > 0,
  );

  const goDirective = readText("scripts/test/live-turn/go.mod").match(
    /^go\s+(\S+)\s*$/mu,
  );
  assert.ok(goDirective, "go.mod go directive");
  assert.equal(asString(tools.go, "go"), goDirective[1]);
  assert.match(ci, /install_args: go\s*$/mu);
  assert.doesNotMatch(ci, /actions\/setup-go/u);
  assert.doesNotMatch(ci, /go-version-file:/u);

  assert.match(asString(tools.java, "java"), /^temurin-17(?:\.|$)/u);
  assert.doesNotMatch(ci, /JAVA_HOME_17_X64/u);
  assert.match(ci, /install_args: rust java cargo:cargo-ndk\s*$/mu);

  const cargoNdkTool = asTable(tools["cargo:cargo-ndk"], "cargo-ndk");
  assert.equal(asString(cargoNdkTool.version, "cargo-ndk.version"), "4.1.2");
  assert.equal(
    asString(
      asTable(cargoNdkTool.install_env, "cargo-ndk.install_env").RUSTUP_TOOLCHAIN,
      "RUSTUP_TOOLCHAIN",
    ),
    "1.94.0",
  );
  assert.doesNotMatch(ci, /cargo install cargo-ndk/u);

  const env = asTable(mise.env, "env");
  assert.equal(
    asString(env.CARGO_TARGET_DIR, "CARGO_TARGET_DIR"),
    "{{env.HOME}}/.cache/packages/cargo-target",
  );
  assert.equal(asString(env.RUSTUP_TOOLCHAIN, "RUSTUP_TOOLCHAIN"), "1.94.0");
  assert.equal(
    asString(env.ANDROID_SDK_PLATFORM, "ANDROID_SDK_PLATFORM"),
    "android-36",
  );
  assert.equal(
    asString(env.ANDROID_BUILD_TOOLS, "ANDROID_BUILD_TOOLS"),
    "35.0.0",
  );
  assert.equal(
    asString(env.ANDROID_BUILD_TOOLS_LATEST, "ANDROID_BUILD_TOOLS_LATEST"),
    "36.0.0",
  );
  assert.equal(
    asString(env.ANDROID_NDK_VERSION, "ANDROID_NDK_VERSION"),
    "28.0.13004108",
  );
  assert.match(ci, /platforms;\$\{ANDROID_SDK_PLATFORM\}/u);
  assert.match(ci, /build-tools;\$\{ANDROID_BUILD_TOOLS\}/u);
  assert.match(ci, /build-tools;\$\{ANDROID_BUILD_TOOLS_LATEST\}/u);
  assert.match(ci, /ndk;\$\{ANDROID_NDK_VERSION\}/u);
  assert.doesNotMatch(ci, /28\.0\.13004108/u);
  assert.equal(
    asBoolean(asTable(mise.settings, "settings").lockfile, "lockfile"),
    true,
  );
  const tasks = asTable(mise.tasks, "tasks");
  for (const name of ["setup", "deps"]) {
    assert.equal(
      asString(asTable(tasks[name], name).run, `${name}.run`),
      "bash scripts/dev/install-dependencies.sh",
    );
  }
});

test("mise.lock exists and names every install platform", () => {
  const lock = readText("mise.lock");
  for (const platform of lockPlatforms) {
    assert.ok(
      lock.includes(`platforms.${platform}`),
      `mise.lock does not mention ${platform}`,
    );
  }
});

test("mise.toml pins the agent skill installer CLIs", () => {
  const mise = parseToml(readText("mise.toml"));
  const tools = asTable(mise.tools, "tools");
  const script = readText("scripts/dev/install-agent-skills.sh");
  const pins = [
    ["npm:skills", "skills@1.7.4"],
    ["npm:impeccable", "impeccable@4.8.0"],
    ["npm:typeui.sh", "typeui.sh@0.7.1"],
  ];
  const lock = readText("mise.lock");
  for (const [tool, spec] of pins) {
    const version = spec.slice(spec.indexOf("@") + 1);
    const slug = tool.slice("npm:".length).replaceAll(".", "-");
    const sidecar = `.mise/locks/npm-${slug}/${version}`;
    assert.equal(asString(tools[tool], tool), version);
    assert.ok(script.includes(spec), spec);
    assert.ok(lock.includes(`path = "${sidecar}"`), sidecar);
    assert.ok(readText(`${sidecar}/aube-lock.yaml`).includes(version), sidecar);
  }
  assert.match(
    script,
    /mise install npm:skills npm:impeccable npm:typeui\.sh/u,
  );
  for (const path of ["AGENTS.md", "docs/contributing/commands.md"]) {
    assert.doesNotMatch(readText(path), /\bpnpm\b/u, path);
  }
});
