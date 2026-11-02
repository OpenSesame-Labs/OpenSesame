import assert from "node:assert/strict";
import { test } from "node:test";
import { planNpmCdRelease } from "./plan-npm-cd-release.mjs";

test("web-pwa cd plan uses web-pwa tag prefix", () => {
  const plan = planNpmCdRelease({
    npmPackageName: "@opensesame-labs/web-pwa",
    sha: "916d491d83d1889bc2b6bc8b13c2eff09cf704fa",
    tagPrefix: "web-pwa-v",
    releaseName: "web-pwa",
    npmVersions: ["0.0.0-alpha.0"],
  });
  assert.equal(plan.version, "0.0.0-alpha.1");
  assert.equal(plan.npmDistTag, "alpha");
  assert.equal(plan.tag, "web-pwa-v0.0.0-alpha.1");
});
