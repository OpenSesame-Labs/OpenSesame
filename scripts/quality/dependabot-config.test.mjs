import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const config = readFileSync(join(root, ".github/dependabot.yml"), "utf8");

test("dependabot npm workspaces use a single root directory entry", () => {
  const npmBlocks = [...config.matchAll(/- package-ecosystem: npm\n([\s\S]*?)(?=\n  - package-ecosystem:|$)/g)];
  assert.equal(npmBlocks.length, 1);
  assert.match(npmBlocks[0][0], /directory: \/\n/);
  assert.match(config, /npm workspaces: one root package-lock\.json at \//);
});

test("dependabot npm group declares patterns for minor and patch", () => {
  assert.match(config, /npm-minor-and-patch:\n        patterns:\n          - "\*"/);
});
