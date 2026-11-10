import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyNpmPublishResult,
  isForbiddenRepublishOfVersion,
} from "./npm-trunk-publish.mjs";

const version = "0.0.0-alpha.23";
const forbidden = `npm error code E403
npm error 403 403 Forbidden - PUT https://registry.npmjs.org/@opensesame-labs%2fcli - You cannot publish over the previously published versions: 0.0.0-alpha.23.`;

test("isForbiddenRepublishOfVersion matches trunk CD 403 body", () => {
  assert.equal(isForbiddenRepublishOfVersion(forbidden, version), true);
  assert.equal(
    isForbiddenRepublishOfVersion(forbidden, "0.0.0-alpha.24"),
    false,
  );
  assert.equal(isForbiddenRepublishOfVersion("npm error 404", version), false);
});

test("classifyNpmPublishResult maps E403 republish to already_published", () => {
  assert.equal(
    classifyNpmPublishResult({ status: 1, stdout: "", stderr: forbidden }, version),
    "already_published",
  );
  assert.equal(
    classifyNpmPublishResult({ status: 0, stdout: "", stderr: "" }, version),
    "published",
  );
  assert.equal(
    classifyNpmPublishResult(
      { status: 1, stdout: "", stderr: "npm error 401" },
      version,
    ),
    "failed",
  );
});
