import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CLAIM,
  GATE,
  assertClean,
  gateFixture,
} from "./exposure-gate-fixture.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");
const workflow = read(".github/workflows/ci.yml");

function jobs(text) {
  return Object.fromEntries(
    [
      ...text
        .split("\njobs:\n")[1]
        .matchAll(
          /^ {2}([a-z][a-z0-9-]*):\n([\s\S]*?)(?=^ {2}[a-z][a-z0-9-]*:\n|(?![\s\S]))/gm,
        ),
    ].map((match) => [match[1], match[2]]),
  );
}

test("root lint and quality entrypoints enforce exposure before optional work", () => {
  const { scripts } = JSON.parse(read("package.json"));
  assert.equal(scripts["audit:exposure"], `node ${GATE}`);
  for (const name of ["lint", "lint:all", "quality"]) {
    assert.ok(scripts[name].startsWith("npm run audit:exposure && "), name);
    assert.doesNotMatch(scripts[name], /audit:exposure\s*(?:\|\||;)/u);
  }
  assert.ok(scripts.verify.startsWith("npm run lint && "));
  assert.match(
    scripts["quality:test"],
    /node --test scripts\/security\/\*\.test\.mjs/u,
  );
});

test("existing hooks invoke the exact index and pushed-ref modes unconditionally", () => {
  const commit = read(".githooks/pre-commit");
  const push = read(".githooks/pre-push");
  for (const source of [commit, push]) {
    assert.match(source, /^set -e$/mu);
    assert.match(source, /^unset NODE_OPTIONS$/mu);
  }
  const staged = `node ${GATE} --staged`;
  const pushed = `node ${GATE} --push-refs`;
  assert.equal(commit.split(staged).length, 2);
  assert.ok(commit.split("\n").includes(staged));
  assert.ok(commit.indexOf(staged) < commit.indexOf("staged_files="));
  assert.equal(push.split(pushed).length, 2);
  assert.ok(push.split("\n").includes(pushed));
  assert.ok(push.indexOf(pushed) < push.indexOf("  off)"));
  assert.ok(push.indexOf(pushed) < push.indexOf("\n      npm run verify\n"));
});

test("a native commit rejects an unsafe index even when the working guard is repaired", (t) => {
  const f = gateFixture(t);
  f.write(".githooks/pre-commit", read(".githooks/pre-commit"));
  chmodSync(f.path(".githooks/pre-commit"), 0o755);
  f.git(["update-index", "--add", "--chmod=+x", ".githooks/pre-commit"]);
  f.git(["config", "core.hooksPath", ".githooks"]);
  f.replace(
    CLAIM,
    'claim.targetManifest.kind !== "secret-drop" && userCode === undefined',
    "userCode === undefined",
  );
  f.git(["add", CLAIM]);
  f.restore(CLAIM);
  const result = f.command([
    "-c",
    "commit.gpgsign=false",
    "-c",
    "user.name=Exposure Fixture",
    "-c",
    "user.email=exposure@example.test",
    "commit",
    "-qm",
    "unsafe staged guard",
  ]);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /EM-DRIFT.*claim-presentation\.ts/su,
  );
  assert.equal(f.git(["rev-parse", "HEAD"]), f.head);
});

test("existing CI prerequisite checks the immutable tree before selecting builds", () => {
  const current = jobs(workflow);
  assert.deepEqual(Object.keys(current), [
    "workflow-inventory-gate",
    "changes",
    "typescript-build",
    "rust-build",
    "typescript",
    "bundle-check",
    "rust-check",
  ]);
  const steps = current.changes.split(/\n {6}- /u);
  const gate = steps.filter((step) => step.includes(`node ${GATE}`));
  assert.equal(gate.length, 1);
  assert.ok(
    gate[0].split("\n").includes(`        run: node ${GATE} --ref HEAD`),
  );
  assert.doesNotMatch(gate[0], /^ {8}(?:if|continue-on-error):/mu);
  const gateIndex = steps.indexOf(gate[0]);
  assert.ok(
    steps.findIndex((step) => step.includes("uses: actions/checkout@")) <
      gateIndex,
  );
  for (const planner of ["plan-ts", "plan-cargo"]) {
    assert.ok(
      steps.findIndex((step) =>
        step.includes(`ci-affected-builds.mjs ${planner}`),
      ) > gateIndex,
    );
  }
  assert.doesNotMatch(current.changes, /^ {4}(?:if|continue-on-error):/mu);
});

test("all required CI reporters always include the exposure prerequisite result", () => {
  const current = jobs(workflow);
  for (const [name, language, build] of [
    ["typescript", "typescript", "typescript-build"],
    ["bundle-check", "typescript", "typescript-build"],
    ["rust-check", "rust", "rust-build"],
  ]) {
    const job = current[name];
    assert.match(job, new RegExp(`^ {4}needs: \\[changes, ${build}\\]$`, "mu"));
    assert.match(job, /^ {4}if: always\(\)$/mu);
    const reporter = job
      .split(/\n {6}- /u)
      .find((step) =>
        step.includes("run: node scripts/lib/ci-required-result.mjs"),
      );
    assert.ok(reporter, name);
    assert.ok(reporter.includes("DRAFT: ${{ needs.changes.outputs.draft }}"));
    assert.ok(
      reporter.includes("PREFLIGHT_RESULT: ${{ needs.changes.result }}"),
    );
    assert.ok(
      reporter.includes(`SELECTED: \${{ needs.changes.outputs.${language} }}`),
    );
    assert.ok(reporter.includes(`SUITE_RESULT: \${{ needs.${build}.result }}`));
    assert.doesNotMatch(reporter, /^ {8}(?:if|continue-on-error):/mu);
    assert.doesNotMatch(job, /^ {4}continue-on-error:/mu);
  }
});

function report(overrides) {
  const env = {
    ...process.env,
    NODE_OPTIONS: "",
    DRAFT: "false",
    PREFLIGHT_RESULT: "success",
    SELECTED: "false",
    SUITE_RESULT: "skipped",
    ...overrides,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  return spawnSync(
    process.execPath,
    [join(root, "scripts/lib/ci-required-result.mjs")],
    {
      encoding: "utf8",
      timeout: 10_000,
      env,
    },
  );
}

/** A local repository standing in for the remote, with one pull request head. */
function remoteWithPull(number) {
  const directory = mkdtempSync(join(tmpdir(), "opensesame-reporter-"));
  const git = (...args) =>
    spawnSync("git", ["-C", directory, ...args], { encoding: "utf8" });
  git("init", "--quiet", "--bare");
  const tree = git("hash-object", "-t", "tree", "-w", "--stdin").stdout.trim();
  const commit = spawnSync(
    "git",
    ["-C", directory, "commit-tree", tree, "-m", "head"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.invalid",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.invalid",
      },
    },
  ).stdout.trim();
  git("update-ref", `refs/pull/${number}/head`, commit);
  return { directory, head: commit };
}

test("a cancelled preflight passes only for a pull request run a newer push replaced", () => {
  const { directory, head } = remoteWithPull(7);
  try {
    const run = (overrides) =>
      report({
        DRAFT: "",
        PREFLIGHT_RESULT: "cancelled",
        SELECTED: "",
        SUITE_RESULT: "cancelled",
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_SERVER_URL: `file://${join(directory, "..")}`,
        GITHUB_REPOSITORY: directory.split("/").at(-1),
        PULL_NUMBER: "7",
        ...overrides,
      });
    assert.match(head, /^[0-9a-f]{40}$/u);
    // The pull request has moved on from the commit this run was started for.
    const replaced = run({ RUN_HEAD_SHA: "0".repeat(40) });
    assert.equal(replaced.status, 0, replaced.stderr);
    assert.equal(replaced.stderr, "");
    // Still the head: cancelled by hand, so it is not a pass.
    assert.notEqual(run({ RUN_HEAD_SHA: head }).status, 0);
    // The same moved head on any other event is not a pass either.
    assert.notEqual(
      run({ RUN_HEAD_SHA: "0".repeat(40), GITHUB_EVENT_NAME: "push" }).status,
      0,
    );
    // A pull request that cannot be found is not known to be superseded.
    assert.notEqual(
      run({ RUN_HEAD_SHA: "0".repeat(40), PULL_NUMBER: "8" }).status,
      0,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("actual CI reporter rejects failed or missing exposure admission despite skipped builds", () => {
  assert.equal(report({}).status, 0);
  for (const preflight of [
    "failure",
    "skipped",
    "canceled",
    "Cancelled",
    undefined,
  ]) {
    const result = report({ PREFLIGHT_RESULT: preflight });
    assert.notEqual(result.status, 0, `preflight=${preflight}`);
    assert.match(result.stderr, /CI required result: preflight:/u);
  }
  // A cancelled preflight classified nothing. Cancelled by hand, on main or
  // in the merge queue, it must not read as a passing check.
  const cancelled = {
    DRAFT: "",
    PREFLIGHT_RESULT: "cancelled",
    SELECTED: "",
    SUITE_RESULT: "cancelled",
  };
  for (const event of ["push", "merge_group", "workflow_dispatch", undefined]) {
    const result = report({ ...cancelled, GITHUB_EVENT_NAME: event });
    assert.notEqual(result.status, 0, `event=${event}`);
    assert.match(result.stderr, /preflight: cancelled, and no newer push/u);
  }
  for (const overrides of [
    { SELECTED: undefined },
    { SELECTED: "true", SUITE_RESULT: "skipped" },
    { SELECTED: "true", SUITE_RESULT: "cancelled" },
    { SELECTED: "false", SUITE_RESULT: "cancelled" },
    { DRAFT: "true" },
  ]) {
    assert.notEqual(report(overrides).status, 0);
  }
  assert.equal(report({ SELECTED: "true", SUITE_RESULT: "success" }).status, 0);
});

test("actual LF attributes keep reviewed index and working bytes equal under autocrlf", (t) => {
  const f = gateFixture(t);
  f.write(".gitattributes", read(".gitattributes"));
  f.write("line-endings.txt", "a default text file\n");
  f.commit("actual canonical LF policy");
  f.git(["config", "core.autocrlf", "true"]);
  f.git(["config", "core.eol", "crlf"]);
  const protectedPaths = [
    CLAIM,
    GATE,
    ".githooks/pre-push",
    "crates/bitwarden-server/Cargo.toml",
  ];
  for (const path of [...protectedPaths, "line-endings.txt"])
    rmSync(f.path(path));
  f.git(["checkout-index", "--all", "--force"]);
  for (const path of protectedPaths) {
    assert.equal(f.git(["check-attr", "eol", "--", path]), `${path}: eol: lf`);
    assert.doesNotMatch(f.read(path), /\r\n/u);
  }
  assert.match(f.read("line-endings.txt"), /\r\n/u);
  assertClean(f.run());
  assertClean(f.run(["--staged"]));
  assertClean(f.run(["--ref", "HEAD"]));
});
