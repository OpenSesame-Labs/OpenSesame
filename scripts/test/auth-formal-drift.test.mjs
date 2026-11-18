import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

test("covered bytes must match both the worktree and the declared reviewed commit", (t) => {
  const root = mkdtempSync(join(tmpdir(), "auth-formal-drift-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  const paths = [
    "packages/control-plane/src/middleware/auth.ts",
    "packages/control-plane/src/proofs/verified-principal.ts",
    "packages/control-plane/src/proofs/project-role.ts",
    "packages/control-plane/src/services/project-access.ts",
    "packages/os-domain/src/types.ts",
  ];
  for (const path of paths) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), "reviewed\n");
  }
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "reviewed sources");
  const reviewed = git("rev-parse", "HEAD");
  writeFileSync(join(root, paths[0]), "different revision\n");
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "different sources");
  const other = git("rev-parse", "HEAD");
  writeFileSync(join(root, paths[0]), "reviewed\n");
  const script = join(root, "scripts/test/auth-formal-drift.mjs");
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(
    script,
    readFileSync(new URL("./auth-formal-drift.mjs", import.meta.url)),
  );
  const manifest = join(root, "spec/formal/auth/coverage.json");
  mkdirSync(dirname(manifest), { recursive: true });
  const sources = paths.map((path) => ({
    path,
    sha256: createHash("sha256")
      .update(readFileSync(join(root, path)))
      .digest("hex"),
  }));
  const check = (revision) => {
    writeFileSync(
      manifest,
      JSON.stringify({ version: 1, reviewed_revision: revision, sources }),
    );
    return spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: "utf8",
    });
  };
  assert.equal(check(reviewed).status, 0);
  const wrong = check(other);
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /reviewed revision does not match/);
  assert.notEqual(check("a".repeat(40)).status, 0);
  git("replace", reviewed, other);
  assert.equal(check(reviewed).status, 0);
});
