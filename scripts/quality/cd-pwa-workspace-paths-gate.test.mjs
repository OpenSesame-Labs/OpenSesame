import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const gate = join(root, "scripts/quality/cd-pwa-workspace-paths-gate.mjs");

test("cd-pwa.yml paths cover the Pages production workspace closure", () => {
  execFileSync(process.execPath, [gate], { cwd: root, stdio: "pipe" });
});