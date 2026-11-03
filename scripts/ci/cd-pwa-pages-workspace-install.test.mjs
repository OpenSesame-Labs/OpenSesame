import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("cd-pwa-pages-workspace-install runs Pages-only npm ci", () => {
  const source = readFileSync(
    new URL("./cd-pwa-pages-workspace-install.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /npm",\s*\["ci", "--include-workspace-root", "-w", "@opensesame\/pages"\]/u,
  );
  assert.doesNotMatch(source, /sharp@/u);
});
