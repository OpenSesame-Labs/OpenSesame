import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { typescriptComponents } from "../lib/workspace-graph.mjs";
import {
  assertCdPwaPaths,
  pathCovers,
  workflowPathFilters,
} from "./cd-pwa-workspace-paths-gate.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const gate = join(root, "scripts/quality/cd-pwa-workspace-paths-gate.mjs");

test("cd-pwa.yml paths cover the Pages production workspace closure", () => {
  execFileSync(process.execPath, [gate], { cwd: root, stdio: "pipe" });
});

test("workflowPathFilters reads only push.paths", () => {
  const yaml = [
    "on:",
    "  push:",
    "    paths:",
    '      - "apps/pages/**"',
    "  pull_request:",
    "    paths:",
    '      - "should-not-count/**"',
    "  workflow_dispatch:",
    "jobs:",
    "  x:",
    "    steps: []",
  ].join("\n");
  assert.deepEqual(workflowPathFilters(yaml), ["apps/pages/**"]);
});

test("pathCovers accepts exact and parent globs only", () => {
  assert.equal(pathCovers(["packages/foo/**"], "packages/foo/**"), true);
  assert.equal(pathCovers(["packages/**"], "packages/foo/**"), true);
  assert.equal(pathCovers(["packages/foo/src/**"], "packages/foo/**"), false);
  assert.equal(pathCovers(["packages/bar/**"], "packages/foo/**"), false);
  assert.equal(pathCovers(["packages/foo/**"], "packages/foobar/**"), false);
});

test("pathCovers honors ordered negative exclusions", () => {
  assert.equal(
    pathCovers(["packages/**", "!packages/foo/**"], "packages/foo/**"),
    false,
  );
  assert.equal(
    pathCovers(["packages/**", "!packages/foo/src/**"], "packages/foo/**"),
    true,
  );
  assert.equal(
    pathCovers(
      ["packages/**", "!packages/foo/**", "packages/foo/**"],
      "packages/foo/**",
    ),
    true,
  );
  assert.equal(
    pathCovers(["!packages/foo/**", "packages/**"], "packages/foo/**"),
    true,
  );
  assert.equal(
    pathCovers(["packages/foo/**", "!packages/**"], "packages/foo/**"),
    false,
  );
});

test("assertCdPwaPaths passes on the live repository", () => {
  assert.deepEqual(assertCdPwaPaths(root), { ok: true });
});

test("assertCdPwaPaths fails when @opensesame/pages is absent", () => {
  const withoutPages = typescriptComponents(root).filter(
    (c) => c.name !== "@opensesame/pages",
  );
  assert.deepEqual(assertCdPwaPaths(root, withoutPages), {
    ok: false,
    missing: [{ name: "@opensesame/pages", glob: "apps/pages/**" }],
  });
});
