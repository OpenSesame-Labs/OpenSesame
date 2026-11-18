import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  fixture,
  installHook,
  push,
  registry,
} from "./formal-proof-push-gate.test.fixture.mjs";

test("an existing stale branch fetches an unknown remote-main policy", (t) => {
  const f = fixture(t);
  installHook(f);
  f.git(
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "-q",
    "origin",
    "HEAD:refs/heads/main",
  );
  f.git("checkout", "-qb", "stale");
  f.git(
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "-q",
    "origin",
    "HEAD:refs/heads/stale",
  );
  const other = join(f.dir, "other");
  mkdirSync(other);
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: other,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("fetch", "-q", f.remote, "refs/heads/main");
  git("checkout", "-qb", "main", "FETCH_HEAD");
  const extended = structuredClone(registry);
  extended.suites[0].implementation.push("src/other");
  for (const name of ["proof-registry.json", "proof-requirements.json"])
    writeFileSync(join(other, "spec/formal", name), JSON.stringify(extended));
  writeFileSync(
    join(other, "scripts/security/formal-proof-pinned-suites.mjs"),
    `export const PINNED_FORMAL_SUITES = ${JSON.stringify(extended.suites)};\n`,
  );
  git("add", "-A");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "extend trusted policy");
  const main = git("rev-parse", "HEAD");
  git(
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "-q",
    f.remote,
    "HEAD:refs/heads/main",
  );
  assert.notEqual(
    spawnSync("git", ["cat-file", "-e", main], { cwd: f.repo }).status,
    0,
  );
  f.write("src/other", "stale implementation\n");
  f.commit();
  const result = push(f, "HEAD", "refs/heads/stale");
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /removes required formal proof mapping a: src\/other/,
  );
  assert.equal(
    spawnSync("git", ["cat-file", "-e", main], { cwd: f.repo }).status,
    0,
  );
  assert.deepEqual(f.commands(), []);
});

function prepareMovingMain(f) {
  const other = join(f.dir, "moving-main");
  mkdirSync(other);
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: other,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("fetch", "-q", f.remote, "refs/heads/main");
  git("checkout", "-qb", "main", "FETCH_HEAD");
  const extended = structuredClone(registry);
  extended.suites[0].implementation.push("src/other");
  for (const name of ["proof-registry.json", "proof-requirements.json"])
    writeFileSync(join(other, "spec/formal", name), JSON.stringify(extended));
  git("add", "-A");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "first main");
  const advertised = git("rev-parse", "HEAD");
  git(
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "-q",
    f.remote,
    "HEAD:refs/heads/main",
  );
  writeFileSync(join(other, "src/newer"), "newer main\n");
  git("add", "-A");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "second main");
  const newer = git("rev-parse", "HEAD");
  git(
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "-q",
    f.remote,
    "HEAD:refs/heads/next",
  );
  return { advertised, newer };
}

function pushWhileMainMoves(f, newer) {
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  writeFileSync(
    join(f.bin, "git"),
    '#!/bin/sh\nif [ "$1" = fetch ]; then "$FORMAL_REAL_GIT" --git-dir "$FORMAL_REMOTE" update-ref refs/heads/main "$FORMAL_NEW"; fi\nexec "$FORMAL_REAL_GIT" "$@"\n',
    { mode: 0o755 },
  );
  const hooks = join(f.dir, "race-hooks");
  mkdirSync(hooks);
  // Git prepends its exec path to hooks. Put the test shim first again, then
  // pass Git's actual pre-push ref stream to the real selector.
  writeFileSync(
    join(hooks, "pre-push"),
    '#!/bin/sh\nPATH="$FORMAL_GIT_BIN:$PATH"\nexport PATH\nexec "$FORMAL_NODE" "$FORMAL_GATE" "$1"\n',
    { mode: 0o755 },
  );
  const result = spawnSync(
    realGit,
    [
      "-c",
      `core.hooksPath=${hooks}`,
      "push",
      "--dry-run",
      "origin",
      "HEAD:refs/heads/stale",
    ],
    {
      cwd: f.repo,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${f.bin}:${process.env.PATH}`,
        FORMAL_GIT_BIN: f.bin,
        FORMAL_REAL_GIT: realGit,
        FORMAL_REMOTE: f.remote,
        FORMAL_NEW: newer,
        FORMAL_NODE: process.execPath,
        FORMAL_GATE: join(
          f.repo,
          "scripts/security/formal-proof-push-gate.mjs",
        ),
        FORMAL_TEST_LOG: f.log,
      },
    },
  );
  return { result, realGit };
}

test("a main update during fetch is rejected even if the old commit remains reachable", (t) => {
  for (const existing of [false, true]) {
    const f = fixture(t);
    installHook(f);
    f.git(
      "-c",
      "core.hooksPath=/dev/null",
      "push",
      "-q",
      "origin",
      "HEAD:refs/heads/main",
    );
    f.git("checkout", "-qb", "stale");
    if (existing)
      f.git(
        "-c",
        "core.hooksPath=/dev/null",
        "push",
        "-q",
        "origin",
        "HEAD:refs/heads/stale",
      );
    const { advertised, newer } = prepareMovingMain(f);
    assert.notEqual(
      spawnSync("git", ["cat-file", "-e", advertised], { cwd: f.repo }).status,
      0,
    );
    f.write("src/other", "stale implementation\n");
    f.commit();
    const { result, realGit } = pushWhileMainMoves(f, newer);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /remote main ref changed.*retry/i);
    assert.equal(
      spawnSync(realGit, ["cat-file", "-e", advertised], { cwd: f.repo })
        .status,
      0,
    );
    assert.deepEqual(f.commands(), []);
  }
});
