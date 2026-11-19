import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const STACK_COVERAGE = [
  "spec/formal/authority/coverage.json",
  "spec/formal/dpop/coverage.json",
];

function assertOnMain(revision) {
  execFileSync(
    "git",
    ["-C", repoRoot, "merge-base", "--is-ancestor", revision, "origin/main"],
    { stdio: "ignore" },
  );
}

for (const rel of STACK_COVERAGE) {
  test(`${rel} reviewed_revision is an ancestor of origin/main`, () => {
    const { reviewed_revision: revision } = JSON.parse(
      readFileSync(join(repoRoot, rel), "utf8"),
    );
    assert.match(revision, /^[0-9a-f]{40}$/);
    assertOnMain(revision);
  });
}

test("branch-only reviewed_revision is rejected by drift helpers", () => {
  const py = spawnSync(
    "python3",
    [
      "-c",
      `
import json, subprocess, tempfile, os
from pathlib import Path
from hashlib import sha256
root = Path(tempfile.mkdtemp())
os.chdir(root)
subprocess.run(["git","init","-q"], check=True)
subprocess.run(["git","config","user.name","t"], check=True)
subprocess.run(["git","config","user.email","t@example.invalid"], check=True)
path = Path("crates/x.rs")
path.parent.mkdir(parents=True)
path.write_text("x\\n")
subprocess.run(["git","add","."], check=True)
subprocess.run(["git","-c","commit.gpgsign=false","commit","-qm","main"], check=True)
main = subprocess.check_output(["git","rev-parse","HEAD"], text=True).strip()
subprocess.run(["git","branch","-M","main"], check=True)
subprocess.run(["git","update-ref","refs/remotes/origin/main", main], check=True)
path.write_text("y\\n")
subprocess.run(["git","checkout","-b","feature"], check=True)
subprocess.run(["git","add","."], check=True)
subprocess.run(["git","-c","commit.gpgsign=false","commit","-qm","feature"], check=True)
branch_only = subprocess.check_output(["git","rev-parse","HEAD"], text=True).strip()
subprocess.run(["git","checkout","main"], check=True)
subprocess.run(["git","merge","--squash","feature"], check=True)
subprocess.run(["git","-c","commit.gpgsign=false","commit","-qm","squashed"], check=True)
import sys
sys.path.insert(0, "${repoRoot}/scripts/security")
from formal_coverage_drift import assert_reviewed_revision_on_main
try:
    assert_reviewed_revision_on_main(root, branch_only, "test")
    raise SystemExit(0)
except SystemExit:
    raise SystemExit(1)
`,
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(py.status, 0);
});

test("formal squash verify script passes on this repository", () => {
  const script = join(repoRoot, "scripts/test/formal-squash-merge-verify.sh");
  const run = spawnSync("bash", [script], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, OPENSESAME_FORMAL_SQUASH_SKIP_LEAN: "1" },
    timeout: 600_000,
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
});
