import assert from "node:assert/strict";
import { test } from "node:test";
import { NPM_PUBLISH } from "./npm-publish-names.mjs";

test("published npm names use the @opensesame-labs scope", () => {
  assert.equal(NPM_PUBLISH.cli.name, "@opensesame-labs/cli");
  assert.equal(NPM_PUBLISH.webPwa.name, "@opensesame-labs/web-pwa");
  assert.match(NPM_PUBLISH.cli.name, /^@opensesame-labs\//);
  assert.match(NPM_PUBLISH.webPwa.name, /^@opensesame-labs\//);
  assert.doesNotMatch(NPM_PUBLISH.cli.name, /^@opensesame\//);
  assert.equal(Object.keys(NPM_PUBLISH.cli.bin)[0], "opensesame");
  assert.equal(Object.keys(NPM_PUBLISH.webPwa.bin)[0], "opensesame-pages");
});
