import assert from "node:assert/strict";
import { test } from "node:test";
import { planNpmCdRelease } from "./plan-npm-cd-release.mjs";

test("cd plan starts at 0.0.0-alpha.0 with alpha dist-tag", () => {
  const plan = planNpmCdRelease({
    npmPackageName: "@opensesame-labs/cli",
    sha: "916d491d83d1889bc2b6bc8b13c2eff09cf704fa",
    tagPrefix: "cli-v",
    releaseName: "cli",
    npmVersions: [],
  });
  assert.equal(plan.version, "0.0.0-alpha.0");
  assert.equal(plan.npmDistTag, "alpha");
  assert.equal(plan.tag, "cli-v0.0.0-alpha.0");
});
