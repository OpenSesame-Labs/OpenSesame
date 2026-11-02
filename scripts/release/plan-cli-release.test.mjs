import assert from "node:assert/strict";
import { test } from "node:test";
import { formatPlan, planCliRelease } from "./plan-cli-release.mjs";

test("nightly plan stamps UTC date and records short sha", () => {
  const plan = planCliRelease({
    mode: "nightly",
    packageVersion: "0.1.0",
    sha: "916d491d83d1889bc2b6bc8b13c2eff09cf704fa",
    stamp: "20261102",
    now: new Date("2026-11-02T12:00:00Z"),
  });
  assert.equal(plan.version, "0.1.0-nightly.20261102");
  assert.equal(plan.tag, "cli-v0.1.0-nightly.20261102");
  assert.equal(plan.shortSha, "916d491");
  assert.equal(plan.npmDistTag, "nightly");
  assert.match(formatPlan(plan), /^version=0\.1\.0-nightly\.20261102/m);
});

test("alpha plan requires a prerelease version in package.json", () => {
  const plan = planCliRelease({
    mode: "alpha",
    packageVersion: "0.2.0-alpha.1",
    sha: "abcdef0",
  });
  assert.equal(plan.version, "0.2.0-alpha.1");
  assert.equal(plan.npmDistTag, "alpha");
});

test("alpha plan rejects stable-only versions", () => {
  assert.throws(
    () =>
      planCliRelease({
        mode: "alpha",
        packageVersion: "0.1.0",
        sha: "abcdef0",
      }),
    /prerelease version/,
  );
});
