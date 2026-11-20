import { expect, test } from "vitest";
import {
  customProfileEvidenceSteps,
  shotsPrecedeCoreRemediation,
} from "./setup-profile-evidence-order.mjs";

test("custom vault shots precede the core-type remediation", () => {
  const offered = customProfileEvidenceSteps(1);
  expect(shotsPrecedeCoreRemediation(offered)).toBe(true);
  expect(offered.indexOf("applied")).toBeLessThan(
    offered.indexOf("enable-core"),
  );
  expect(offered.indexOf("features")).toBeLessThan(
    offered.indexOf("enable-core"),
  );
  expect(customProfileEvidenceSteps(0)).toEqual(["applied", "features"]);
  expect(
    shotsPrecedeCoreRemediation(["enable-core", "applied", "features"]),
  ).toBe(false);
});
