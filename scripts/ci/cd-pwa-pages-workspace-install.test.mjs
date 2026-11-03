import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { pinnedSharpVersion } from "./cd-pwa-pages-workspace-install.mjs";

test("pinnedSharpVersion matches root package.json devDependencies", () => {
  const version = pinnedSharpVersion();
  assert.match(version, /^[0-9]+\.[0-9]+\.[0-9]+$/u);
});

test("cd-pwa-pages-workspace-install links sharp after Pages workspace ci", () => {
  const source = readFileSync(
    new URL("./cd-pwa-pages-workspace-install.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /pinnedSharpVersion\(\)/u);
  assert.match(source, /sharp@\$\{sharpVersion\}/u);
  assert.match(source, /--prefer-offline/u);
});
