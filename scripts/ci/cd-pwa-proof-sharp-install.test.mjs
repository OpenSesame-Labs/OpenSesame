import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { pinnedSharpVersion } from "./cd-pwa-proof-sharp-install.mjs";

test("pinnedSharpVersion matches root package.json override pin", () => {
  const version = pinnedSharpVersion();
  assert.equal(version, "0.35.5");
});

test("cd-pwa-proof-sharp-install uses legacy-peer-deps for isolated sharp link", () => {
  const source = readFileSync(
    new URL("./cd-pwa-proof-sharp-install.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /--legacy-peer-deps/u);
  assert.match(source, /--prefer-offline/u);
});
