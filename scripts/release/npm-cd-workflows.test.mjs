import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CD_PRODUCTION_DIST_TAG } from "./npm-prerelease-version.mjs";

const root = join(import.meta.dirname, "../..");

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

test("npm CD publishes cli and web-pwa and drops env-spec-bridge", () => {
  assert.equal(
    existsSync(join(root, ".github/workflows/cd-npm-env-spec-bridge.yml")),
    false,
  );
  assert.equal(
    existsSync(join(root, "scripts/release/prepare-env-spec-release.mjs")),
    false,
  );
  const cli = read(".github/workflows/cd-npm-cli.yml");
  const pwa = read(".github/workflows/cd-pwa.yml");
  const action = read(".github/actions/publish-npm-package/action.yml");
  assert.match(cli, /@opensesame-labs\/cli/);
  assert.match(
    cli,
    new RegExp(
      `dist-tag add "@opensesame-labs/cli@\\$\\{version\\}" ${CD_PRODUCTION_DIST_TAG}`,
    ),
  );
  assert.match(
    pwa,
    new RegExp(
      `dist-tag add "\\$\\{name\\}@\\$\\{version\\}" ${CD_PRODUCTION_DIST_TAG}`,
    ),
  );
  for (const text of [cli, pwa, action]) {
    assert.doesNotMatch(text, /env-spec-bridge/);
    assert.doesNotMatch(text, /--tag\s+latest/);
    assert.doesNotMatch(text, /dist-tag add[^\n]*\slatest\b/);
  }
  assert.match(action, /Refusing dist-tag latest/);
  assert.doesNotMatch(read(".gitignore"), /env-spec-bridge\/release/);
  const spec = JSON.parse(read("docs/ci/github-setup-spec.json"));
  assert.equal(spec.npm_versioning.initial, "0.0.0-alpha.0");
  assert.equal(
    spec.npm_versioning.dist_tags.preview_publish.startsWith("alpha"),
    true,
  );
  assert.match(spec.npm_versioning.dist_tags.production_promotion, /^next /);
  assert.deepEqual(
    spec.npm_packages.map((entry) => entry.name),
    ["@opensesame-labs/cli", "@opensesame-labs/web-pwa"],
  );
});
