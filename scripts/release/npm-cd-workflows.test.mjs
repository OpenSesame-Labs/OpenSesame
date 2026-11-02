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
    assert.doesNotMatch(text, /npm install -g npm@/);
    assert.match(text, /npx -y npm@11\.21\.1/);
  }
  assert.match(action, /Refusing dist-tag latest/);
  assert.match(
    action,
    /test "\$\(npx -y npm@11\.21\.1 --version\)" = "11\.21\.1"/,
  );
  assert.match(cli, /group: cd-npm-cli\n {2}cancel-in-progress: true/);
  assert.match(pwa, /group: cd-pwa\n {2}cancel-in-progress: true/);
  assert.doesNotMatch(cli, /cancel-in-progress: false/);
  assert.doesNotMatch(pwa, /cancel-in-progress: false/);
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

test("npm publish proof lints workflow YAML and stages the alpha dry-run", () => {
  const proof = read(".github/workflows/cd-npm-publish-proof.yml");
  assert.match(proof, /pull_request:/);
  assert.match(proof, /download-actionlint\.bash" 1\.7\.7 \.cache\/actionlint/);
  assert.match(
    proof,
    /node --test scripts\/release\/npm-cd-workflows\.test\.mjs/,
  );
  assert.match(
    proof,
    /node scripts\/release\/npm-cd-publish-dry-run-proof\.mjs/,
  );
  assert.match(proof, /\.github\/workflows\/cd-npm-cli\.yml/);
  assert.match(proof, /\.github\/workflows\/cd-pwa\.yml/);
  assert.match(proof, /\.github\/workflows\/cd-npm-publish-proof\.yml/);
  assert.doesNotMatch(proof, /action\.yml/);
});
