/**
 * Build `origin/main` Pages dist for before/after evidence (mirrored node_modules).
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTree } from "./round8-profile-trees.mjs";

const repoRoot = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../..",
);

const mainSha = () =>
  execFileSync("git", ["rev-parse", "origin/main"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();

/** Main-line dist for before shots (`npm ci` + `vite build` in a detached worktree). */
export function mainPagesDist() {
  const preset = process.env.SETUP_PAUSE_MAIN_DIST;
  if (preset && existsSync(path.join(preset, "index.html"))) {
    return preset;
  }
  const tree = ensureTree(mainSha());
  const outDir = path.join(tree, "apps/pages/dist");
  if (existsSync(path.join(outDir, "index.html"))) {
    return outDir;
  }
  execFileSync("mise", ["exec", "--", "npm", "ci"], {
    cwd: tree,
    stdio: "inherit",
  });
  execFileSync(
    "mise",
    ["exec", "--", "npm", "run", "build", "-w", "@opensesame/pages"],
    {
      cwd: tree,
      stdio: "inherit",
    },
  );
  if (!existsSync(path.join(outDir, "index.html"))) {
    throw new Error(`main dist missing at ${outDir}`);
  }
  return outDir;
}
