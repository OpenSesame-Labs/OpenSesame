/**
 * Worktree bytes for a full checkout versus the proof sparse path lists.
 * Local clones hardlink objects; sparse-checkout uses --no-cone so root file
 * patterns (a leading slash, or a bare package.json) match the CI behavior.
 *
 *   node scripts/ci/measure-sparse-checkout-footprint.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SPARSE_CI_GATE,
  SPARSE_WORKSPACE_BUILD,
} from "../lib/ci-sparse-checkout-paths.mjs";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "../..");

function git(args, cwd) {
  const ran = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (ran.status !== 0) {
    throw new Error(ran.stderr || ran.stdout || `git ${args.join(" ")}`);
  }
  return ran.stdout;
}

function worktreeBytes(repo) {
  const ran = spawnSync(
    "bash",
    [
      "-lc",
      "find . -path ./.git -prune -o -type f -print0 | du -b --files0-from=- | awk '{s+=$1} END {print s+0}'",
    ],
    { cwd: repo, encoding: "utf8" },
  );
  if (ran.status !== 0) throw new Error(ran.stderr || "du failed");
  return Number(ran.stdout.trim());
}

function measure(label, patterns) {
  const parent = mkdtempSync(join(tmpdir(), `sparse-${label}-`));
  const repo = join(parent, "repo");
  const started = performance.now();
  try {
    git(["clone", "--local", "--depth", "1", root, repo], parent);
    if (patterns.length > 0) {
      git(["sparse-checkout", "set", "--no-cone", ...patterns], repo);
    }
    return {
      bytes: worktreeBytes(repo),
      elapsedMs: Math.round(performance.now() - started),
      pathCount: patterns.length,
    };
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

const head = git(["rev-parse", "HEAD"], root).trim();
const report = {
  schemaVersion: 1,
  sourceCommit: head,
  capturedAt: new Date().toISOString(),
  method:
    "local git clone --depth 1, then sparse-checkout set --no-cone for file and directory patterns; worktree bytes exclude .git",
  scenarios: {
    beforeFullTree: measure("full", []),
    afterInventoryGate: measure("inventory", SPARSE_CI_GATE),
    afterWorkspaceBuild: measure("workspace", SPARSE_WORKSPACE_BUILD),
  },
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
