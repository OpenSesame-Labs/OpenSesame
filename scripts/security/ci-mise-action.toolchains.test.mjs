import assert from "node:assert/strict";
import { test } from "node:test";
import { readString } from "../lib/json-boundary.mjs";
import {
  miseUses,
  parse,
  runText,
  workflows,
} from "./ci-mise-action.fixtures.mjs";

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
