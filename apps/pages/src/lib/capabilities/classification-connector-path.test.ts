import { expect, it } from "vitest";
import { classify } from "./classification.js";

it("shares only the pure connector path helper with Settings", () => {
  expect(
    classify("packages/app-core/src/sections/connections/path.ts"),
  ).toMatchObject({ classification: "shared", capability: null });
  expect(classify("src/sections/connections/path.ts")).toMatchObject({
    classification: "optional",
    capability: "connectors.external",
  });
  expect(
    classify("packages/app-core/src/sections/connections/path-helper.ts"),
  ).toBeNull();
});
