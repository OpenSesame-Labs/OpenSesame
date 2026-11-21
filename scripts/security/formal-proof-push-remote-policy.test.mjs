import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  fixture,
  installHook,
  productionFixture,
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

function tamperInventory(f, kind, id, pins, rows) {
  if (kind === "remove-self") {
    rows[1][1] = [".npmrc"];
    rows.find((row) => row[0] === "suite" && row[1] === "auth")[3] = [
      "package.json",
    ];
    f.write(pins, JSON.stringify(rows));
  } else if (kind === "valid-inventory-edit") {
    rows[1][1].push("package.json");
    f.write(pins, JSON.stringify(rows));
  } else if (kind === "minimum-signature" || kind === "transient-weakened") {
    const suite = rows.find((row) => row[0] === "suite" && row[1] === id);
    suite[3] = suite[3].filter(
      (path) => !path.endsWith("/required-theorems.lean"),
    );
    f.write(pins, JSON.stringify(rows));
  } else if (kind === "minimum-runner") {
    const suite = rows.find((row) => row[0] === "suite" && row[1] === id);
    suite[3] = suite[3].filter(
      (path) => path !== "scripts/test/auth-formal.sh",
    );
    f.write(pins, JSON.stringify(rows));
  } else if (kind === "minimum-shared") {
    rows[1][1] = rows[1][1].filter(
      (path) => path !== "spec/formal/check-axioms.sh",
    );
    f.write(pins, JSON.stringify(rows));
  } else if (kind === "minimum-cargo" || kind === "minimum-sentinel") {
    const suite = rows.find((row) => row[0] === "suite" && row[1] === id);
    suite[kind === "minimum-cargo" ? 4 : 5] = [];
    f.write(pins, JSON.stringify(rows));
  } else if (kind === "duplicate") {
    rows.push(rows.find((row) => row[0] === "suite" && row[1] === "auth"));
    f.write(pins, JSON.stringify(rows));
  } else if (kind === "symlink") {
    rmSync(join(f.repo, pins));
    symlinkSync("elsewhere", join(f.repo, pins));
  } else f.write(pins, "{");
}

test("invalid or weakened inventory fails closed", (t) => {
  for (const kind of [
    "remove-self",
    "valid-inventory-edit",
    "malformed",
    "duplicate",
    "symlink",
    "malformed-only",
    "minimum-signature",
    "minimum-runner",
    "minimum-shared",
    "minimum-cargo",
    "minimum-sentinel",
    "transient-malformed",
    "transient-weakened",
  ]) {
    const metadata =
      kind.startsWith("minimum-") || kind.startsWith("transient-");
    const id =
      kind === "minimum-cargo" || kind === "minimum-sentinel"
        ? "authority"
        : "auth";
    const f = productionFixture(t, id);
    if (metadata) {
      const policy = JSON.parse(
        readFileSync(
          join(f.repo, "spec/formal/proof-requirements.json"),
          "utf8",
        ),
      );
      const signature = `spec/formal/${id}/required-theorems.lean`;
      if (!policy.suites[0].proofs.includes(signature))
        policy.suites[0].proofs.push(signature);
      f.pin(policy);
      for (const name of ["proof-registry", "proof-requirements"])
        f.write(`spec/formal/${name}.json`, JSON.stringify(policy));
      f.commit();
      f.git(
        "-c",
        "core.hooksPath=/dev/null",
        "push",
        "-q",
        "origin",
        "HEAD:refs/heads/main",
      );
    }
    const pins = "scripts/security/formal-proof-runner-pins.json";
    const original = readFileSync(join(f.repo, pins), "utf8");
    const rows = JSON.parse(original);
    if (kind !== "malformed-only" && !metadata) {
      f.write("src/a", "changed\n");
      f.write("scripts/test/auth-formal.sh", "#!/bin/sh\nexit 0\n");
    }
    tamperInventory(f, kind, id, pins, rows);
    f.commit();
    if (kind.startsWith("transient-")) {
      f.write(pins, original);
      f.commit();
    }
    const result = push(f, "HEAD", "refs/heads/main");
    assert.notEqual(result.status, 0, kind);
    assert.match(
      result.stderr,
      /formal runner inventory|formal-proof-runner-pins\.json/i,
      kind,
    );
    assert.deepEqual(f.commands(), []);
  }
});
