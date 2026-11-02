import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NPM_PUBLISH,
  PWA_NPM_PACKAGE_NAME_PLACEHOLDER,
} from "./npm-publish-names.mjs";

test("published npm names use the @opensesame-labs scope", () => {
  assert.match(NPM_PUBLISH.cli.name, /^@opensesame-labs\//);
  assert.match(NPM_PUBLISH.pagesPwa.name, /^@opensesame-labs\//);
  assert.equal(NPM_PUBLISH.pagesPwa.name, PWA_NPM_PACKAGE_NAME_PLACEHOLDER);
  assert.doesNotMatch(NPM_PUBLISH.cli.name, /^@opensesame\//);
  assert.equal(Object.keys(NPM_PUBLISH.cli.bin)[0], "opensesame");
  assert.equal(Object.keys(NPM_PUBLISH.pagesPwa.bin)[0], "opensesame-pages");
});
