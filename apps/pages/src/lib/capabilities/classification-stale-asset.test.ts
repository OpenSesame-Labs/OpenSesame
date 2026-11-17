import { expect, it } from "vitest";
import { classify } from "./classification.js";

it("classifies the reload regression with its exact shell owner", () => {
  expect(classify("src/lib/stale-asset-reload.test.ts")).toMatchObject({
    pattern: "src/lib/stale-asset-reload.test.ts",
    classification: "core",
    capability: "shell.navigation",
  });
  expect(classify("src/lib/stale-asset-reload.testament.ts")).toBeNull();
  expect(classify("src/lib/stale-asset-reloads.test.ts")).toBeNull();
});
