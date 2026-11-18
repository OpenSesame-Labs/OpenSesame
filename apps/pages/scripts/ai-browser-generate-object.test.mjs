import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import {
  aiBrowserBoundaryPaths,
  aiBrowserGenerateObject,
  readAiBrowserBoundary,
  validateAiBrowserBoundary,
} from "./ai-browser-generate-object.mjs";

test("the narrow browser call is pinned to its sole facade and caller", () => {
  const input = readAiBrowserBoundary();
  assert.deepEqual(input, {
    caller: aiBrowserBoundaryPaths.caller,
    facade: aiBrowserBoundaryPaths.facade,
    implementation: aiBrowserBoundaryPaths.implementation,
  });
  assert.throws(
    () =>
      validateAiBrowserBoundary(
        input.facade,
        `${readFileSync(input.facade, "utf8")}\n`,
      ),
    /source pin mismatch/,
  );
});

test("the build plugin rewires only the pinned facade", () => {
  const plugin = aiBrowserGenerateObject();
  plugin.buildStart();
  assert.equal(plugin.resolveId("ai", "/fixture/other.ts"), null);
  const id = plugin.resolveId("ai", aiBrowserBoundaryPaths.facade);
  assert.equal(id, aiBrowserBoundaryPaths.virtual);
  assert.match(plugin.load(id), /browser-generate-object\.ts/);
});
