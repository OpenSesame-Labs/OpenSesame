import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readString } from "../lib/json-boundary.mjs";
import {
  miseUses,
  parse,
  runText,
  workflowDir,
  workflows,
} from "./ci-mise-action.fixtures.mjs";
import { workflowsWithMiseCacheDisabled } from "./ci-mise-cache-policy.mjs";

const miseLine =
  /uses:\s+jdx\/mise-action@b44d12e7d0d8ee7461bb893e1b1993500433185b # v5\.2\.7\s*$/u;
const allowedArgs = new Set([
  "node",
  "node@24",
  "hurl@8.1.0",
  "rust",
  "rust@1.97.1",
  "rust[components=miri]@nightly-2026-08-01",
  "go",
  "java",
  "cargo:cargo-ndk",
]);

function nonComment(text) {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

/**
 * These CD workflows do not use mise-action. GitHub 504s on the action's
 * jdx/mise release metadata fetch. Their jobs install the pinned tarball
 * instead. PWA preview smoke also installs the locked Hurl used by the Pages
 * checks; GHCR installs Node and Rust in separate jobs; the npm CLI installs
 * Node 24.
 */
const pwaLockedMiseWorkflows = new Set([
  "cd-pwa.yml",
  "cd-pwa-profile-proof.yml",
]);
// Workflows whose installer invocation is `node@24` (optionally with more tools).
const node24LockedMiseWorkflows = new Set([
  "cd-npm-cli.yml",
  ...pwaLockedMiseWorkflows,
]);
const lockedMiseWorkflows = new Set([
  "cd-ghcr-publish.yml",
  ...node24LockedMiseWorkflows,
]);
const lockedMiseBootstraps = new Set([
  "bash scripts/lib/install-mise-locked.sh node",
  "bash scripts/lib/install-mise-locked.sh rust",
  "bash scripts/lib/install-mise-locked.sh node@24",
  "bash scripts/lib/install-mise-locked.sh node@24 hurl@8.1.0",
]);

function installsLockedMise(step) {
  return lockedMiseBootstraps.has(runText(step).trim());
}

test("workflows do not set up Node with setup-node, pnpm, or corepack", () => {
  const files = workflows();
  assert.ok(files.length > 0);
  for (const { name, text } of files) {
    // The signed-commit gate installs only Node 24. It does not run the toolchain.
    if (name !== "ci-grok-commits.yml") {
      assert.doesNotMatch(text, /actions\/setup-node/u, name);
      assert.doesNotMatch(text, /setup-node/u, name);
    }
    assert.doesNotMatch(text, /pnpm\/action-setup/u, name);
    assert.doesNotMatch(text, /\bcorepack\b/u, name);
    assert.doesNotMatch(text, /cache:\s*pnpm/u, name);
    assert.doesNotMatch(
      nonComment(text),
      /\bpnpm\b(?!-workspace\.yaml)/u,
      name,
    );
  }
});

/** Where a job installs mise or the locked bootstrap, and first runs npm or node. */
function stepPositions(steps) {
  const miseAt = [];
  const bootstrapAt = [];
  let npmAt = -1;
  let nodeAt = -1;
  steps.forEach((step, index) => {
    if (step?.uses === miseUses) miseAt.push(index);
    if (installsLockedMise(step)) bootstrapAt.push(index);
    const run = runText(step);
    if (npmAt < 0 && /\bnpm\s+(?:ci|run|exec)\b/u.test(run)) {
      npmAt = index;
    }
    if (nodeAt < 0 && /\bnode\s+\S/u.test(run)) nodeAt = index;
  });
  return { miseAt, bootstrapAt, npmAt, nodeAt };
}

/** A locked-bootstrap job never uses mise-action and bootstraps before npm. */
function assertLockedBootstrapJob(name, label, at) {
  const { miseAt, bootstrapAt, npmAt, nodeAt } = at;
  assert.equal(miseAt.length, 0, `${label} uses mise-action`);
  // PWA CD runs every node step on the locked toolchain. GHCR runs its
  // helper scripts on the runner's Node and only needs it for npm.
  const needsLockedNode = pwaLockedMiseWorkflows.has(name)
    ? npmAt >= 0 || nodeAt >= 0
    : npmAt >= 0;
  if (needsLockedNode) {
    assert.ok(bootstrapAt.length > 0, `${label} runs node without locked mise`);
  }
  if (npmAt >= 0) {
    assert.ok(bootstrapAt[0] < npmAt, `${label} runs npm before locked mise`);
  }
}

/** Every job that runs npm installs Node first, by its workflow's route. */
function assertNodeInstalledBeforeNpm(name, label, at) {
  if (lockedMiseWorkflows.has(name)) {
    assertLockedBootstrapJob(name, label, at);
  } else if (at.npmAt >= 0) {
    assert.ok(at.miseAt.length > 0, `${label} runs npm without mise`);
    assert.ok(at.miseAt[0] < at.npmAt, `${label} installs npm before mise`);
  }
}

/** The native Go analysis job keeps Go out of its mise install. */
function assertNoGoInstallArgs(steps, miseAt, label) {
  for (const index of miseAt) {
    const tokens = String(steps[index]?.with?.install_args ?? "")
      .split(/\s+/u)
      .filter((token) => token !== "");
    assert.equal(tokens.includes("go"), false, label);
  }
}

/** Other installers in the job that the same mise tool must not sit beside. */
function blockedTools(job) {
  const body = JSON.stringify(job);
  return {
    rust: body.includes("dtolnay/rust-toolchain"),
    go: body.includes("actions/setup-go"),
    java: body.includes("JAVA_HOME_17_X64"),
    ndk: body.includes("cargo install cargo-ndk"),
  };
}

function assertMiseCache(name, step, expectCacheDisabled, label) {
  // Untrusted refs install mise with its Actions cache off. Trusted refs
  // on ci.yml keep cache: true and cache_save: false. Nightly selection
  // jobs set cache: false so they cannot write the default-branch cache.
  const untrustedOnly = step.if === "env.TRUSTED_CACHE_SAVE != 'true'";
  const nightlyOptOut =
    name === "dev-nightly.yml" || name === "dev-nightly-qualify.yml";
  const cacheExpected =
    untrustedOnly || nightlyOptOut ? false : !expectCacheDisabled;
  assert.equal(step.with?.cache, cacheExpected, label);
}

/** install_args lists only allowed tools, none of them installed twice. */
function assertInstallArgs(step, blocks, label) {
  const args = readString(step.with?.install_args);
  assert.notEqual(args, undefined, label);
  const tokens = (args ?? "").split(/\s+/u).filter((token) => token !== "");
  assert.ok(tokens.length > 0, label);
  for (const token of tokens) {
    assert.ok(allowedArgs.has(token), `${label} ${token}`);
  }
  assert.equal(tokens.includes("rust") && blocks.rust, false, label);
  assert.equal(tokens.includes("go") && blocks.go, false, label);
  assert.equal(tokens.includes("java") && blocks.java, false, label);
  assert.equal(tokens.includes("cargo:cargo-ndk") && blocks.ndk, false, label);
  return tokens;
}

/** A working_directory is `src` or the runner temp, each with its own tools. */
function assertWorkingDirectory(step, tokens, label) {
  if (step.with.working_directory === undefined) return;
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

/** Raw `uses:` lines agree with the parsed steps and carry the pinned SHA. */
function assertRawMiseLines(name, text, parsedMise) {
  const rawMise = text
    .split("\n")
    .filter((line) => line.includes("jdx/mise-action@"));
  if (lockedMiseWorkflows.has(name)) {
    assert.equal(rawMise.length, 0, name);
    assert.equal(parsedMise, 0, name);
    if (node24LockedMiseWorkflows.has(name)) {
      assert.match(
        text,
        /bash scripts\/lib\/install-mise-locked\.sh node@24/u,
        name,
      );
    } else {
      assert.match(
        text,
        /bash scripts\/lib\/install-mise-locked\.sh node\n/u,
        name,
      );
      assert.match(
        text,
        /bash scripts\/lib\/install-mise-locked\.sh rust\n/u,
        name,
      );
    }
  }
  assert.equal(rawMise.length, parsedMise, name);
  for (const line of rawMise) assert.match(line, miseLine, name);
}

test("npm jobs install Node with the pinned mise-action", () => {
  const cacheDisabled = new Set(workflowsWithMiseCacheDisabled());
  for (const { name, text } of workflows()) {
    const jobs = parse(text).jobs ?? {};
    const expectCacheDisabled = cacheDisabled.has(name);
    let parsedMise = 0;
    for (const [id, job] of Object.entries(jobs)) {
      const steps = Array.isArray(job?.steps) ? job.steps : [];
      const label = `${name}:${id}`;
      const at = stepPositions(steps);
      parsedMise += at.miseAt.length;
      assertNodeInstalledBeforeNpm(name, label, at);
      const blocks = blockedTools(job);
      if (id === "analyze-native-go") {
        assertNoGoInstallArgs(steps, at.miseAt, label);
      }
      for (const index of at.miseAt) {
        const step = steps[index];
        assertMiseCache(name, step, expectCacheDisabled, label);
        const tokens = assertInstallArgs(step, blocks, label);
        assertWorkingDirectory(step, tokens, label);
      }
    }
    assertRawMiseLines(name, text, parsedMise);
  }
});

test("PWA CD installs tools with the locked mise bootstrap, not mise-action", () => {
  for (const name of pwaLockedMiseWorkflows) {
    const text = readFileSync(join(workflowDir, name), "utf8");
    assert.doesNotMatch(text, /jdx\/mise-action/u, name);
    assert.doesNotMatch(text, /install_args:/u, name);
    assert.doesNotMatch(text, /actions\/cache\/save@/u, name);
    assert.doesNotMatch(text, /^[ \t]+cache:[ \t]+true[ \t]*$/mu, name);
    assert.match(
      text,
      /bash scripts\/lib\/install-mise-locked\.sh node@24/u,
      name,
    );
  }
  const pwa = readFileSync(join(workflowDir, "cd-pwa.yml"), "utf8");
  const proof = readFileSync(
    join(workflowDir, "cd-pwa-profile-proof.yml"),
    "utf8",
  );
  assert.match(
    pwa,
    /bash scripts\/lib\/install-mise-locked\.sh node@24 hurl@8\.1\.0/u,
  );
  assert.doesNotMatch(proof, /hurl@/u);
});

test("cd-npm-cli installs Node with the locked mise bootstrap, not mise-action", () => {
  const text = readFileSync(join(workflowDir, "cd-npm-cli.yml"), "utf8");
  assert.equal(lockedMiseWorkflows.has("cd-npm-cli.yml"), true);
  assert.doesNotMatch(text, /jdx\/mise-action/u);
  assert.doesNotMatch(text, /install_args:/u);
  assert.match(text, /bash scripts\/lib\/install-mise-locked\.sh node@24/u);
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
