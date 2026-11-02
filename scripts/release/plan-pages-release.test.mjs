import assert from "node:assert/strict";
import { test } from "node:test";
import { planCliRelease } from "./plan-cli-release.mjs";

test("pages-pwa channel plan uses pages-pwa tag prefix", () => {
  const plan = planCliRelease({
    mode: "channel",
    packageVersion: "0.1.0",
    sha: "916d491d83d1889bc2b6bc8b13c2eff09cf704fa",
    stamp: "20261102",
    now: new Date("2026-11-02T12:00:00Z"),
    tagPrefix: "pages-pwa-v",
    releaseName: "pages-pwa",
  });
  assert.equal(plan.tag, "pages-pwa-v0.1.0");
  assert.equal(plan.npmDistTag, "preview");
});
