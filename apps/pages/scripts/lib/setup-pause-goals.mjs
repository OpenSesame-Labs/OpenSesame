import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../..",
);

let cached;

/** Walkthrough ids from the merged registry (core plus loaded packs). */
export function mergedGuideGoalCount() {
  if (cached !== undefined) return cached;
  const out = execFileSync(
    "npx",
    [
      "tsx",
      "-e",
      "import { guideGoalIds } from './packages/app-core/src/tutorial/registry/goals.ts'; console.log(guideGoalIds().length)",
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    },
  );
  // tsx paints a number when FORCE_COLOR is set; the count is the digits.
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  const plain = out.replace(ansi, "");
  cached = Number.parseInt(plain.trim(), 10);
  if (!Number.isFinite(cached) || cached < 2) {
    throw new Error(`unexpected merged guide goal count: ${out}`);
  }
  return cached;
}

/** Matches `LIMIT` in `packages/app-core/src/lib/tutorial-queue.ts`. */
export const TUTORIAL_QUEUE_LIMIT = 80;

export function expectedPauseAllQueueCount(mergedGoals) {
  return Math.min(mergedGoals, TUTORIAL_QUEUE_LIMIT);
}
