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
  assert.match(pwa, /@opensesame\/pages/);
  const publishUses = (text) =>
    text.split("./.github/actions/publish-npm-package").length - 1;
  // Preview publishes alpha; Production publishes next via OIDC.
  assert.equal(publishUses(cli), 2);
  assert.equal(publishUses(pwa), 2);
  for (const text of [cli, pwa]) {
    assert.match(text, new RegExp(`npm-dist-tag: ${CD_PRODUCTION_DIST_TAG}`));
    assert.match(text, /npm-token: ""/);
    assert.match(text, /secrets\.NPM_TOKEN/);
    assert.doesNotMatch(text, /npx -y npm@11\.21\.1/);
    const production = text.slice(text.indexOf("\n  production:"));
    assert.doesNotMatch(production, /secrets\.NPM_TOKEN/);
    assert.doesNotMatch(production, /dist-tag add/);
  }
  for (const text of [cli, pwa, action]) {
    assert.doesNotMatch(text, /env-spec-bridge/);
    assert.doesNotMatch(text, /--tag\s+latest/);
    assert.doesNotMatch(text, /dist-tag add/);
    assert.doesNotMatch(text, /npm install -g npm@/);
  }
  assert.match(action, /npx -y npm@11\.21\.1/);
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
  assert.match(proof, /\.github\/workflows\/cd-pwa-profile-proof\.yml/);
  assert.doesNotMatch(proof, /action\.yml/);
});

test("CD promotes staged artifacts and waits only on Production", () => {
  const cli = read(".github/workflows/cd-npm-cli.yml");
  const pwa = read(".github/workflows/cd-pwa.yml");
  const spec = JSON.parse(read("docs/ci/github-setup-spec.json"));
  for (const text of [cli, pwa]) {
    assert.doesNotMatch(text, /name: Preview\n/);
    assert.match(text, /name: Production\n/);
    assert.equal((text.match(/run: npm run build/g) ?? []).length, 1);
    assert.match(text, /cd-release-meta\.mjs write /);
    assert.match(text, /cd-release-meta\.mjs check /);
  }
  assert.doesNotMatch(pwa, /Preview gate/);
  assert.match(pwa, /name: github-pages\n/);
  assert.equal(
    (cli.match(/npm-cli-release-\$\{\{ github\.run_id \}\}/g) ?? []).length,
    3,
  );
  assert.equal(
    (cli.match(/cd-npm-cli-meta-\$\{\{ github\.run_id \}\}/g) ?? []).length,
    3,
  );
  assert.equal(
    (pwa.match(/npm-pages-pwa-release-\$\{\{ github\.run_id \}\}/g) ?? [])
      .length,
    3,
  );
  assert.equal(
    (pwa.match(/pages-dist-\$\{\{ github\.run_id \}\}/g) ?? []).length,
    2,
  );
  assert.match(cli, /needs: \[stage, preview\]/);
  assert.match(pwa, /needs: \[build, deploy, npm_preview\]/);
  assert.equal(
    spec.environments.find((entry) => entry.name === "Preview").used_by.length,
    0,
  );
  assert.deepEqual(
    spec.environments.find((entry) => entry.name === "Production")
      .protection_rules.required_reviewers,
    ["Tyler Kendrick"],
  );
  assert.deepEqual(
    spec.environments.find((entry) => entry.name === "github-pages")
      .protection_rules.required_reviewers,
    [],
  );
  const commands = spec.github_environment_changes_via_gh.commands.join("\n");
  assert.match(
    commands,
    /DELETE repos\/OpenSesame-Labs\/OpenSesame\/environments\/Preview\/deployment-protection-rules\/70926078/,
  );
  assert.match(commands, /"id":145080887/);
  assert.doesNotMatch(commands, /deployment-protection-rules\/70926080/);
  assert.match(commands, /environments\/github-pages/);
  assert.equal(spec.promotion_model.production.includes("Production"), true);
});
