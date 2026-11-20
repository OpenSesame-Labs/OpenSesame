import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  fixture,
  installHook,
  push,
} from "./formal-proof-push-gate.test.fixture.mjs";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const registry = JSON.parse(read("spec/formal/proof-registry.json"));
const authority = registry.suites.find((suite) => suite.id === "authority");

function initialize(t) {
  const f = fixture(t);
  const policy = { version: 1, suites: [authority] };
  f.pin(policy);
  for (const name of ["proof-registry.json", "proof-requirements.json"])
    f.write(`spec/formal/${name}`, JSON.stringify(policy));
  for (const proof of authority.proofs) f.write(proof, "proof\n");
  for (const path of [
    "Cargo.toml",
    "Cargo.lock",
    "crates/domain/Cargo.toml",
    "crates/domain/src/lib.rs",
  ])
    f.write(path, read(path));
  installHook(f);
  f.git(
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "-q",
    "origin",
    "HEAD:refs/heads/main",
  );
  return f;
}

function replaceOnce(value, before, after) {
  assert.equal(
    value.split(before).length,
    2,
    `expected one occurrence of ${before}`,
  );
  return value.replace(before, after);
}

function expectPush(f, selected) {
  const result = push(f, "HEAD", "refs/heads/main");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    f.commands(),
    selected ? ["run verify:authority-formal"] : [],
  );
}

function checksumChanged(lock, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(\\[\\[package\\]\\]\\nname = "${escaped}"\\nversion = "[^"]+"\\nsource = "[^"]+"\\nchecksum = ")[a-f0-9]{64}("\\n)`,
  );
  assert.match(lock, pattern);
  return lock.replace(pattern, `$1${"f".repeat(64)}$2`);
}

test("authority native pushes select only relevant manifest and lock inputs", (t) => {
  for (const [kind, path, change, selected] of [
    [
      "crate manifest",
      "crates/domain/Cargo.toml",
      (s) => `${s}\n# reviewed crate change\n`,
      true,
    ],
    [
      "crate root module wiring",
      "crates/domain/src/lib.rs",
      (s) =>
        replaceOnce(
          s,
          "pub mod grant;",
          '#[path = "alternate_grant.rs"]\npub mod grant;',
        ),
      true,
    ],
    [
      "implicit build script",
      "crates/domain/build.rs",
      () => "fn main() {}\n",
      true,
    ],
    [
      "inherited feature",
      "Cargo.toml",
      (s) =>
        replaceOnce(
          s,
          'serde = { version = "1.0.219", features = ["derive"] }',
          'serde = { version = "1.0.219", features = ["derive", "rc"] }',
        ),
      true,
    ],
    [
      "unrelated dependency",
      "Cargo.toml",
      (s) => replaceOnce(s, 'async-nats = "0.52.0"', 'async-nats = "0.53.0"'),
      false,
    ],
    [
      "unrelated member",
      "Cargo.toml",
      (s) =>
        replaceOnce(
          s,
          '  "crates/domain",',
          '  "crates/domain",\n  "crates/unrelated",',
        ),
      false,
    ],
    [
      "reachable profile",
      "Cargo.toml",
      (s) =>
        replaceOnce(
          s,
          "[profile.dev.package.sha2]\nopt-level = 3",
          "[profile.dev.package.sha2]\nopt-level = 2",
        ),
      true,
    ],
    [
      "unrelated profile",
      "Cargo.toml",
      (s) =>
        replaceOnce(
          s,
          "[profile.dev.package.opensesame-human-vault]\nopt-level = 3",
          "[profile.dev.package.opensesame-human-vault]\nopt-level = 2",
        ),
      false,
    ],
    ["reachable lock", "Cargo.lock", (s) => checksumChanged(s, "serde"), true],
    [
      "unrelated lock",
      "Cargo.lock",
      (s) => checksumChanged(s, "async-nats"),
      false,
    ],
  ]) {
    const f = initialize(t);
    f.write(path, change(path === "crates/domain/build.rs" ? "" : read(path)));
    f.commit();
    const result = push(f, "HEAD", "refs/heads/main");
    assert.equal(result.status, 0, `${kind}: ${result.stderr}`);
    assert.deepEqual(
      f.commands(),
      selected ? ["run verify:authority-formal"] : [],
      kind,
    );
  }
});

test("transient relevant workspace changes select authority", (t) => {
  const f = initialize(t);
  const original = read("Cargo.toml");
  f.write(
    "Cargo.toml",
    replaceOnce(
      original,
      'serde = { version = "1.0.219", features = ["derive"] }',
      'serde = { version = "1.0.219", features = ["derive", "rc"] }',
    ),
  );
  f.commit();
  f.write("Cargo.toml", original);
  f.commit();
  expectPush(f, true);
});

test("a restored workspace input on a merged side branch selects authority", (t) => {
  const f = initialize(t);
  const main = f.git("branch", "--show-current");
  f.git("checkout", "-qb", "side");
  const original = read("Cargo.toml");
  f.write(
    "Cargo.toml",
    replaceOnce(
      original,
      'serde = { version = "1.0.219", features = ["derive"] }',
      'serde = { version = "1.0.219", features = ["derive", "rc"] }',
    ),
  );
  f.commit();
  f.write("Cargo.toml", original);
  f.commit();
  f.git("checkout", "-q", main);
  f.write("src/other", "merge\n");
  f.commit();
  f.git(
    "-c",
    "commit.gpgsign=false",
    "merge",
    "--no-ff",
    "-qm",
    "merge",
    "side",
  );
  expectPush(f, true);
});

test("malformed or non-regular workspace inputs fail closed", (t) => {
  for (const kind of [
    "toml",
    "missing-key",
    "missing-package",
    "symlink-package",
    "bad-lock",
  ]) {
    const f = initialize(t);
    let workspace = read("Cargo.toml");
    if (kind === "toml") workspace += "\ninvalid = [\n";
    if (kind === "missing-key")
      workspace = replaceOnce(
        workspace,
        'serde = { version = "1.0.219", features = ["derive"] }\n',
        "",
      );
    if (kind === "missing-package")
      rmSync(join(f.repo, "crates/domain/Cargo.toml"));
    if (kind === "symlink-package") {
      rmSync(join(f.repo, "crates/domain/Cargo.toml"));
      symlinkSync("../../Cargo.toml", join(f.repo, "crates/domain/Cargo.toml"));
    }
    if (kind === "bad-lock") f.write("Cargo.lock", "version = [\n");
    f.write("Cargo.toml", `${workspace}\n# select manifest input\n`);
    f.commit();
    const result = push(f, "HEAD", "refs/heads/main");
    assert.notEqual(result.status, 0, kind);
    assert.match(result.stderr, /projection/i, kind);
    assert.deepEqual(f.commands(), []);
  }
});

test("unrelated and proof-only changes skip authority", (t) => {
  for (const path of ["src/other", "spec/formal/authority/Authority.lean"]) {
    const f = initialize(t);
    f.write(path, "updated\n");
    f.commit();
    expectPush(f, false);
  }
});

test("authority scratch archive preserves dirty inputs and rejects unsafe snapshots", (t) => {
  const f = fixture(t);
  f.write(".gitignore", "src/ignored\nsrc/optional-ignored\n");
  f.write(
    "spec/formal/authority/coverage.json",
    JSON.stringify({
      sources: [{ path: "src/ignored" }],
      optional_sources: [{ path: "src/optional-ignored" }],
    }),
  );
  f.commit();
  const runner = fileURLToPath(
    new URL("../../spec/formal/authority/negative-control.py", import.meta.url),
  );
  const probe = `import pathlib, runpy, sys
scope = runpy.run_path(sys.argv[1], run_name="authority_snapshot_probe")
scope["archive"](pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]))`;
  const snapshot = (name) => {
    const target = join(f.dir, name);
    mkdirSync(target);
    return {
      target,
      result: spawnSync(
        "python3",
        ["-I", "-c", probe, runner, f.repo, target],
        { encoding: "utf8" },
      ),
    };
  };
  f.write("src/a", "dirty reviewed bytes\n");
  rmSync(join(f.repo, "src/b"));
  f.write("src/new", "untracked bytes\n");
  f.write("src/ignored", "ignored covered bytes\n");
  f.write("src/optional-ignored", "ignored optional bytes\n");
  const copied = snapshot("copied");
  assert.equal(copied.result.status, 0, copied.result.stderr);
  assert.equal(
    readFileSync(join(copied.target, "src/a"), "utf8"),
    "dirty reviewed bytes\n",
  );
  assert.equal(
    readFileSync(join(copied.target, "src/new"), "utf8"),
    "untracked bytes\n",
  );
  assert.equal(existsSync(join(copied.target, "src/b")), false);
  assert.equal(
    readFileSync(join(copied.target, "src/ignored"), "utf8"),
    "ignored covered bytes\n",
  );
  assert.equal(
    readFileSync(join(copied.target, "src/optional-ignored"), "utf8"),
    "ignored optional bytes\n",
  );
  symlinkSync("a", join(f.repo, "src/link"));
  const linked = snapshot("linked");
  assert.notEqual(linked.result.status, 0);
  assert.match(linked.result.stderr, /unexpected symlink/);
  rmSync(join(f.repo, "src/link"));
  f.git("add", "src/a");
  const staged = snapshot("staged");
  assert.notEqual(staged.result.status, 0);
  assert.match(staged.result.stderr, /empty index/);
});

test("interrupted authority archive keeps the scratch lease until its child exits", (t) => {
  const f = fixture(t);
  const runner = fileURLToPath(
    new URL("../../spec/formal/authority/negative-control.py", import.meta.url),
  );
  const helper = fileURLToPath(
    new URL("./formal-cargo-isolation.py", import.meta.url),
  );
  const driver = `import os, pathlib, runpy, shutil, signal, subprocess, sys, time
runner, helper, repo, outer, bin_dir = map(pathlib.Path, sys.argv[1:])
real_git = shutil.which("git")
assert real_git
wrapper = bin_dir / "git"
wrapper.write_text('''#!/usr/bin/env python3
import os, pathlib, sys, time
if sys.argv[1:2] == ["archive"]:
    assert pathlib.Path("/dev/fd/" + os.environ["OPENSESAME_FORMAL_SCRATCH_LOCK_FD"]).exists()
    pathlib.Path(os.environ["STARTED"]).write_text("started")
    while not pathlib.Path(os.environ["RELEASE"]).exists(): time.sleep(0.01)
os.execv(os.environ["REAL_GIT"], [os.environ["REAL_GIT"], *sys.argv[1:]])
''')
wrapper.chmod(0o700)
started, release, attempted, acquired = (outer / name for name in ("started", "release", "attempted", "acquired"))
env = os.environ.copy() | {"TMPDIR": str(outer), "PATH": str(bin_dir) + os.pathsep + os.environ["PATH"],
    "REAL_GIT": real_git, "STARTED": str(started), "RELEASE": str(release)}
worker_code = '''import os, pathlib, runpy, sys
runner, helper, repo = map(pathlib.Path, sys.argv[1:])
archive = runpy.run_path(str(runner), run_name="archive_probe")["archive"]
scope = runpy.run_path(str(helper), run_name="lease_probe")
with scope["scratch_checkout"](repo) as lease:
    os.environ["OPENSESAME_FORMAL_SCRATCH_LOCK_FD"] = str(lease.lock_fd)
    archive(repo, lease.path, (lease.lock_fd,))
'''
contender_code = '''import pathlib, runpy, sys
helper, repo, attempted, acquired = map(pathlib.Path, sys.argv[1:])
scope = runpy.run_path(str(helper), run_name="lease_probe")
attempted.write_text("attempted")
with scope["scratch_checkout"](repo) as lease:
    assert not list(lease.path.iterdir())
    acquired.write_text("acquired")
'''
worker = subprocess.Popen([sys.executable, "-I", "-c", worker_code, str(runner), str(helper), str(repo)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
contender = None
try:
    deadline = time.monotonic() + 20
    while not started.exists() and worker.poll() is None and time.monotonic() < deadline: time.sleep(0.01)
    assert started.exists(), "archive child did not start"
    worker.kill()
    assert worker.wait(timeout=10) == -signal.SIGKILL
    contender = subprocess.Popen([sys.executable, "-I", "-c", contender_code, str(helper), str(repo), str(attempted), str(acquired)], env=env)
    deadline = time.monotonic() + 10
    while not attempted.exists() and contender.poll() is None and time.monotonic() < deadline: time.sleep(0.01)
    assert attempted.exists(), "successor did not attempt the lease"
    time.sleep(0.1)
    assert contender.poll() is None and not acquired.exists(), "successor entered before archive child exited"
    release.write_text("release")
    assert contender.wait(timeout=20) == 0 and acquired.exists()
finally:
    release.write_text("release")
    if worker.poll() is None: worker.kill(); worker.wait()
    if contender is not None and contender.poll() is None: contender.kill(); contender.wait()
`;
  const result = spawnSync(
    "python3",
    ["-I", "-c", driver, runner, helper, f.repo, f.dir, f.bin],
    { encoding: "utf8", timeout: 60000 },
  );
  assert.equal(result.status, 0, result.stderr);
});
