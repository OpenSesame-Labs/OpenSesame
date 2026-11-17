import { expect, it } from "vitest";
import { classify } from "./classification.js";

it("keeps gate presence shared and assigns verification tests to their owners", () => {
  expect(classify("src/tutorial/gate-presence.ts")).toMatchObject({
    classification: "shared",
    capability: null,
  });
  for (const [test, implementation] of [
    [
      "src/tutorial/tutorial-route.property.test.tsx",
      "src/tutorial/use-support-route.ts",
    ],
    [
      "src/lib/github-connection-lifecycle.property.test.ts",
      "src/lib/backup-target-local.ts",
    ],
  ]) {
    expect(classify(test)).toMatchObject({
      classification: classify(implementation)?.classification,
      capability: classify(implementation)?.capability,
    });
  }
});
