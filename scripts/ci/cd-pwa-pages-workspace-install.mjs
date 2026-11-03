#!/usr/bin/env node
/**
 * Frozen install for CD PWA jobs that only need the Pages workspace graph.
 * Trunk CI already ran TypeScript, Rust, and Bundle budgets on the same commit.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function main() {
  const ran = spawnSync(
    "npm",
    ["ci", "--include-workspace-root", "-w", "@opensesame/pages"],
    {
      cwd: resolve(fileURLToPath(new URL("../..", import.meta.url))),
      stdio: "inherit",
      env: process.env,
    },
  );
  if (ran.error) {
    console.error(ran.error.message);
    process.exit(1);
  }
  process.exit(ran.status ?? 1);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main();
}
