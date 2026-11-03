import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertCommitSignedByGrok } from "../dev/grok-commit-guard.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("grok-commit-guard rejects an unsigned commit line", () => {
  assert.throws(
    () =>
      assertCommitSignedByGrok({
        signature: "N",
        authorEmail: "noreply@x.ai",
      }),
    /refuses unsigned/,
  );
});

test("grok-commit-guard CLI rejects unsigned range in a temp repo", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "grok-guard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (args) => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result;
  };
  run(["init", "-b", "main"]);
  mkdirSync(join(dir, "hooks"));
  run(["config", "user.email", "noreply@x.ai"]);
  run(["config", "user.name", "Grok"]);
  run(["config", "commit.gpgsign", "false"]);
  run(["config", "core.hooksPath", join(dir, "hooks")]);
  run(["commit", "--allow-empty", "-m", "base"]);
  writeFileSync(join(dir, "f.txt"), "x\n");
  run(["add", "f.txt"]);
  run(["commit", "-m", "unsigned"]);
  const guard = spawnSync(
    process.execPath,
    [
      join(root, "scripts/dev/grok-commit-guard.mjs"),
      "--range",
      "HEAD~1..HEAD",
    ],
    { cwd: dir, encoding: "utf8" },
  );
  assert.notEqual(guard.status, 0);
  assert.match(guard.stderr + guard.stdout, /refuses unsigned/);
});
