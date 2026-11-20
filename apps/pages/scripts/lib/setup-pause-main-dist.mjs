/**
 * Build `origin/main` Pages dist for before/after evidence without checking it out.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../..",
);
const worktree = path.join(repoRoot, "work", "setup-pause-main-tree");
const marker = path.join(worktree, "apps", "pages", "dist", "index.html");

export function mainPagesDist() {
  if (existsSync(marker)) {
    return path.dirname(marker);
  }
  if (!existsSync(worktree)) {
    execFileSync(
      "git",
      ["worktree", "add", "-f", worktree, "origin/main"],
      { cwd: repoRoot, stdio: "inherit" },
    );
  }
  execFileSync("npm", ["run", "build", "-w", "@opensesame/pages"], {
    cwd: worktree,
    stdio: "inherit",
    env: { ...process.env, CI: process.env.CI ?? "1" },
  });
  if (!existsSync(marker)) {
    throw new Error(`main dist missing after build: ${marker}`);
  }
  return path.dirname(marker);
}