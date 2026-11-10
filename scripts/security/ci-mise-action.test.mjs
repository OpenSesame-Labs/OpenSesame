import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readString } from "../lib/json-boundary.mjs";
import { workflowsWithMiseCacheDisabled } from "./ci-mise-cache-policy.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const workflowDir = join(root, ".github/workflows");
const { parse } = createRequire(import.meta.url)("yaml");

const miseUses = "jdx/mise-action@f5be966e4a917d54244728e6a5fdcd1d93a35e6c";
const miseLine =
  /uses:\s+jdx\/mise-action@f5be966e4a917d54244728e6a5fdcd1d93a35e6c # v5\.2\.6\s*$/u;
const allowedArgs = new Set([
  "node",
  "node@24",
  "rust",
  "rust@1.97.1",
  "rust[components=miri]@nightly-2026-08-01",
  "go",
  "java",
  "cargo:cargo-ndk",
]);

/**
 * cd-ghcr-publish.yml does not use mise-action. GitHub 504s on the action's
 * jdx/mise release metadata fetch. Those jobs install the pinned tarball instead.
 */
const lockedMiseWorkflows = new Set(["cd-ghcr-publish.yml"]);
const lockedMiseBootstraps = new Set([
  "bash scripts/lib/install-mise-locked.sh node",
  "bash scripts/lib/install-mise-locked.sh rust",
]);

function installsLockedMise(step) {
  return lockedMiseBootstraps.has(runText(step).trim());
}

function workflows() {
  return readdirSync(workflowDir)
    .filter((name) => name.endsWith(".yml"))
    .sort()
    .map((name) => ({
      name,
      text: readFileSync(join(workflowDir, name), "utf8"),
    }));
}

function nonComment(text) {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

function runText(step) {
  return readString(step?.run) ?? "";
}

test("workflows do not set up Node with setup-node, pnpm, or corepack", () => {
  const files = workflows();
  assert.ok(files.length > 0);
  for (const { name, text } of files) {
    assert.doesNotMatch(text, /actions\/setup-node/u, name);
    assert.doesNotMatch(text, /pnpm\/action-setup/u, name);
    assert.doesNotMatch(text, /\bcorepack\b/u, name);
    assert.doesNotMatch(text, /setup-node/u, name);
    assert.doesNotMatch(text, /cache:\s*pnpm/u, name);
    assert.doesNotMatch(nonComment(text), /\bpnpm\b/u, name);
  }
});

test("npm jobs install Node with the pinned mise-action", () => {
  const cacheDisabled = new Set(workflowsWithMiseCacheDisabled());
  for (const { name, text } of workflows()) {
    const jobs = parse(text).jobs ?? {};
    const expectCacheDisabled = cacheDisabled.has(name);
    const lockedBootstrap = lockedMiseWorkflows.has(name);
    let parsedMise = 0;
    for (const [id, job] of Object.entries(jobs)) {
      const steps = Array.isArray(job?.steps) ? job.steps : [];
      const label = `${name}:${id}`;
      const miseAt = [];
      const bootstrapAt = [];
      let npmAt = -1;
      steps.forEach((step, index) => {
        if (step?.uses === miseUses) miseAt.push(index);
        if (installsLockedMise(step)) bootstrapAt.push(index);
        if (npmAt < 0 && /\bnpm\s+(?:ci|run|exec)\b/u.test(runText(step))) {
          npmAt = index;
        }
      });
      parsedMise += miseAt.length;
      if (lockedBootstrap) {
        assert.equal(miseAt.length, 0, `${label} uses mise-action`);
        if (npmAt >= 0) {
          assert.ok(
            bootstrapAt.length > 0,
            `${label} runs npm without locked mise`,
          );
          assert.ok(
            bootstrapAt[0] < npmAt,
            `${label} installs npm before locked mise`,
          );
        }
      } else if (npmAt >= 0) {
        assert.ok(miseAt.length > 0, `${label} runs npm without mise`);
        assert.ok(miseAt[0] < npmAt, `${label} installs npm before mise`);
      }
      const body = JSON.stringify(job);
      const blocksRust = body.includes("dtolnay/rust-toolchain");
      const blocksGo = body.includes("actions/setup-go");
      const blocksJava = body.includes("JAVA_HOME_17_X64");
      const blocksNdk = body.includes("cargo install cargo-ndk");
      if (id === "analyze-native-go") {
        for (const index of miseAt) {
          const tokens = String(steps[index]?.with?.install_args ?? "")
            .split(/\s+/u)
            .filter((token) => token !== "");
          assert.equal(tokens.includes("go"), false, label);
        }
      }
      for (const index of miseAt) {
        const step = steps[index];
        const cacheExpected = !expectCacheDisabled;
        assert.equal(step.with?.cache, cacheExpected, label);
        const args = readString(step.with?.install_args);
        assert.notEqual(args, undefined, label);
        const tokens = (args ?? "")
          .split(/\s+/u)
          .filter((token) => token !== "");
        assert.ok(tokens.length > 0, label);
        for (const token of tokens) {
          assert.ok(allowedArgs.has(token), `${label} ${token}`);
        }
        assert.equal(tokens.includes("rust") && blocksRust, false, label);
        assert.equal(tokens.includes("go") && blocksGo, false, label);
        assert.equal(tokens.includes("java") && blocksJava, false, label);
        assert.equal(
          tokens.includes("cargo:cargo-ndk") && blocksNdk,
          false,
          label,
        );
        if (step.with.working_directory !== undefined) {
          const directory = step.with.working_directory;
          assert.equal(tokens.includes("node@24"), false, label);
          if (directory === "src") {
            assert.equal(
              tokens.includes("node") || tokens.includes("rust"),
              true,
              label,
            );
          } else {
            assert.equal(directory, "${{ runner.temp }}", label);
            assert.equal(tokens.includes("node"), false, label);
            assert.equal(
              tokens.some(
                (token) =>
                  token === "rust" ||
                  token.startsWith("rust@") ||
                  token.startsWith("rust["),
              ),
              true,
              label,
            );
          }
        }
      }
    }
    const rawMise = text
      .split("\n")
      .filter((line) => line.includes("jdx/mise-action@"));
    if (lockedBootstrap) {
      assert.equal(rawMise.length, 0, name);
      assert.equal(parsedMise, 0, name);
      assert.match(text, /bash scripts\/lib\/install-mise-locked\.sh node\n/u);
      assert.match(text, /bash scripts\/lib\/install-mise-locked\.sh rust\n/u);
    }
    assert.equal(rawMise.length, parsedMise, name);
    for (const line of rawMise) assert.match(line, miseLine, name);
  }
});

test("GHCR CD installs tools with the locked mise bootstrap, not mise-action", () => {
  const text = readFileSync(join(workflowDir, "cd-ghcr-publish.yml"), "utf8");
  assert.equal(lockedMiseWorkflows.has("cd-ghcr-publish.yml"), true);
  assert.doesNotMatch(text, /jdx\/mise-action/u);
  assert.doesNotMatch(text, /install_args:/u);
  assert.match(text, /bash scripts\/lib\/install-mise-locked\.sh node\n/u);
  assert.match(text, /bash scripts\/lib\/install-mise-locked\.sh rust\n/u);
  assert.doesNotMatch(text, /actions\/cache\/save@/u);
  assert.doesNotMatch(text, /uses:\s+actions\/cache@/u);
});

function rustTokens(step) {
  if (step?.uses !== miseUses) return [];
  const args = readString(step.with?.install_args);
  if (args === undefined) return [];
  return args.split(/\s+/u).filter((token) => token !== "");
}

function installsRust(step) {
  if (runText(step).trim() === "bash scripts/lib/install-mise-locked.sh rust") {
    return true;
  }
  return rustTokens(step).some(
    (token) =>
      token === "rust" ||
      token.startsWith("rust@") ||
      token.startsWith("rust["),
  );
}

function needsRust(step) {
  const uses = readString(step?.uses);
  if (uses?.startsWith("Swatinem/rust-cache@")) {
    return true;
  }
  return /\b(?:cargo|rustup)\s+/u.test(runText(step));
}

test("workflows do not install Rust with dtolnay/rust-toolchain", () => {
  const files = workflows();
  assert.ok(files.length > 0);
  for (const { name, text } of files) {
    assert.doesNotMatch(text, /dtolnay\/rust-toolchain/u, name);
    assert.doesNotMatch(text, /rust-toolchain@/u, name);
  }
});

test("cargo jobs install Rust with the pinned mise-action", () => {
  for (const { name, text } of workflows()) {
    const jobs = parse(text).jobs ?? {};
    for (const [id, job] of Object.entries(jobs)) {
      const steps = Array.isArray(job?.steps) ? job.steps : [];
      const label = `${name}:${id}`;
      let needAt = -1;
      const rustAt = [];
      steps.forEach((step, index) => {
        if (needAt < 0 && needsRust(step)) needAt = index;
        if (installsRust(step)) rustAt.push(index);
      });
      if (needAt >= 0) {
        assert.ok(rustAt.length > 0, `${label} runs cargo without mise rust`);
        assert.ok(rustAt[0] < needAt, `${label} runs cargo before mise rust`);
      }
      assert.equal(
        JSON.stringify(job).includes("dtolnay/rust-toolchain"),
        false,
        label,
      );
    }
  }
});

function toolTokens(step) {
  return rustTokens(step);
}

function installsTool(step, name) {
  return toolTokens(step).includes(name);
}

function needsGo(step) {
  const run = runText(step);
  return (
    /\bgo\s+(?:build|test|list|mod|run)\b/u.test(run) ||
    /\btest:live-fixtures\b/u.test(run) ||
    /audit-crypto\.sh\b/u.test(run)
  );
}

function needsJava(step) {
  return /\bsdkmanager\b|\bgradle\b/u.test(runText(step));
}

function needsNdk(step) {
  return /build-core\.sh android\b/u.test(runText(step));
}

test("workflows do not install Go, Java, or cargo-ndk outside mise", () => {
  const files = workflows();
  assert.ok(files.length > 0);
  for (const { name, text } of files) {
    assert.doesNotMatch(text, /actions\/setup-go/u, name);
    assert.doesNotMatch(text, /go-version-file:/u, name);
    assert.doesNotMatch(text, /JAVA_HOME_17_X64/u, name);
    assert.doesNotMatch(text, /cargo install cargo-ndk/u, name);
    assert.doesNotMatch(text, /28\.0\.13004108/u, name);
    if (text.includes("sdkmanager")) {
      assert.match(text, /platforms;\$\{ANDROID_SDK_PLATFORM\}/u, name);
      assert.match(text, /build-tools;\$\{ANDROID_BUILD_TOOLS\}/u, name);
      assert.match(text, /build-tools;\$\{ANDROID_BUILD_TOOLS_LATEST\}/u, name);
      assert.match(text, /ndk;\$\{ANDROID_NDK_VERSION\}/u, name);
    }
  }
});

test("go, java, and cargo-ndk jobs install those tools with mise", () => {
  for (const { name, text } of workflows()) {
    const jobs = parse(text).jobs ?? {};
    for (const [id, job] of Object.entries(jobs)) {
      const steps = Array.isArray(job?.steps) ? job.steps : [];
      const label = `${name}:${id}`;
      const check = (needs, installs, tool) => {
        let needAt = -1;
        const at = [];
        steps.forEach((step, index) => {
          if (needAt < 0 && needs(step)) needAt = index;
          if (installs(step)) at.push(index);
        });
        if (needAt >= 0) {
          assert.ok(at.length > 0, `${label} needs mise ${tool}`);
          assert.ok(at[0] < needAt, `${label} uses ${tool} before mise`);
        }
      };
      if (id !== "analyze-native-go") {
        check(needsGo, (step) => installsTool(step, "go"), "go");
      }
      check(needsJava, (step) => installsTool(step, "java"), "java");
      check(
        needsNdk,
        (step) => installsTool(step, "cargo:cargo-ndk"),
        "cargo:cargo-ndk",
      );
    }
  }
});
