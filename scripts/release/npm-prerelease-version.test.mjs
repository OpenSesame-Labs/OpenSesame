import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CD_PREVIEW_DIST_TAG,
  CD_PRODUCTION_DIST_TAG,
  nextCdPrereleaseVersion,
  npmDistTagForPrerelease,
} from "./npm-prerelease-version.mjs";

test("first CD publish is 0.0.0-alpha.0", () => {
  assert.equal(nextCdPrereleaseVersion([]), "0.0.0-alpha.0");
});

test("subsequent CD publishes bump the prerelease counter", () => {
  assert.equal(
    nextCdPrereleaseVersion(["0.0.0-alpha.0", "0.0.0-alpha.2"]),
    "0.0.0-alpha.3",
  );
});

test("npm dist-tag for prereleases is the preid, not latest", () => {
  assert.equal(npmDistTagForPrerelease("0.0.0-alpha.4"), CD_PREVIEW_DIST_TAG);
  assert.equal(CD_PREVIEW_DIST_TAG, "alpha");
  assert.equal(CD_PRODUCTION_DIST_TAG, "next");
  assert.notEqual(CD_PRODUCTION_DIST_TAG, "latest");
  assert.notEqual(CD_PREVIEW_DIST_TAG, "latest");
});
