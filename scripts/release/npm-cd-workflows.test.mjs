import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CD_PRODUCTION_DIST_TAG } from "./npm-prerelease-version.mjs";

const root = join(import.meta.dirname, "../..");

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

function jobSlice(text, jobKey, nextJobKey) {
  const start = text.indexOf(`\n  ${jobKey}:`);
  const end = text.indexOf(`\n  ${nextJobKey}:`);
  assert.ok(start > 0 && end > start);
  return text.slice(start, end);
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
  for (const text of [cli, pwa]) {
    assert.doesNotMatch(text, /env-spec-bridge/);
    assert.doesNotMatch(text, /--tag\s+latest/);
    assert.doesNotMatch(text, /dist-tag add/);
    assert.doesNotMatch(text, /npm install -g npm@/);
  }
  assert.doesNotMatch(action, /env-spec-bridge/);
  assert.doesNotMatch(action, /--tag\s+latest/);
  assert.doesNotMatch(action, /dist-tag add/);
  assert.doesNotMatch(action, /npm install -g npm@/);
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

test("Production OIDC-publishes 0.0.0-next.N and does not move dist-tags", () => {
  const cli = read(".github/workflows/cd-npm-cli.yml");
  const pwa = read(".github/workflows/cd-pwa.yml");
  const action = read(".github/actions/publish-npm-package/action.yml");
  const spec = JSON.parse(read("docs/ci/github-setup-spec.json"));
  for (const text of [cli, pwa]) {
    assert.doesNotMatch(text, /dist-tag add/);
    const start = text.indexOf("\n  production:");
    const end = text.indexOf("\n  promotion_failed:");
    assert.ok(start > 0 && end > start);
    const production = text.slice(start, end);
    assert.match(production, /name: Production\n/);
    assert.match(production, /cd-release-meta\.mjs check /);
    assert.match(production, /cd-production-npm-version\.mjs rewrite /);
    assert.match(production, /publish-npm-package/);
    assert.match(
      production,
      new RegExp(`npm-dist-tag: ${CD_PRODUCTION_DIST_TAG}\\n`),
    );
    assert.match(production, /npm-token: \$\{\{ secrets\.NPM_TOKEN \}\}\n/);
    assert.doesNotMatch(production, /npm-token: ""/);
    assert.doesNotMatch(production, /NODE_AUTH_TOKEN/);
  }
  assert.match(action, /0\.0\.0-next\.N/);
  assert.match(action, /--provenance/);
  assert.match(action, /export NODE_AUTH_TOKEN="\$NPM_TOKEN_INPUT"/);
  assert.match(action, /unset NODE_AUTH_TOKEN/);
  assert.match(spec.promotion_model.production, /0\.0\.0-next\.N/);
  assert.match(spec.promotion_model.production, /NPM_TOKEN/);
  assert.match(spec.promotion_model.production, /provenance/);
  assert.match(spec.promotion_model.production, /OIDC/);
  assert.match(spec.promotion_model.preview, /NPM_TOKEN/);
  assert.match(spec.promotion_model.preview, /OIDC/);
  const productionEnv = spec.environments.find(
    (entry) => entry.name === "Production",
  );
  assert.match(productionEnv.secrets.NPM_TOKEN, /OIDC/);
  const publishers = spec.npm_trusted_publishing.publishers;
  assert.equal(Array.isArray(publishers), true);
  const rows = publishers.map(
    (row) => `${row.package}:${row.workflow_filename}:${row.environment}`,
  );
  assert.ok(rows.includes("@opensesame-labs/cli:cd-npm-cli.yml:Preview"));
  assert.ok(rows.includes("@opensesame-labs/cli:cd-npm-cli.yml:Production"));
  assert.ok(rows.includes("@opensesame-labs/web-pwa:cd-pwa.yml:Preview"));
  assert.ok(rows.includes("@opensesame-labs/web-pwa:cd-pwa.yml:Production"));
  for (const row of publishers) {
    assert.equal(row.provider, "github-actions");
    assert.equal(row.owner, "OpenSesame-Labs");
    assert.equal(row.repository, "OpenSesame");
  }
  const dry = read("scripts/release/npm-cd-publish-dry-run-proof.mjs");
  assert.match(
    dry,
    /\/opt\/cursor\/artifacts\/npm-cd-production-dry-run-proof\.log/,
  );
  assert.match(dry, /rewritePackageVersionFile/);
});

test("npm publish proof lints workflow YAML and stages the alpha dry-run", () => {
  const proof = read(".github/workflows/cd-npm-publish-proof.yml");
  assert.match(proof, /pull_request:/);
  assert.match(proof, /download-actionlint\.bash" 1\.7\.7 \.cache\/actionlint/);
  assert.match(
    proof,
    /node --test scripts\/release\/npm-cd-workflows\.test\.mjs/,
  );
  assert.match(proof, /scripts\/release\/cd-production-npm-version\.test\.mjs/);
  assert.match(
    proof,
    /node scripts\/release\/npm-cd-publish-dry-run-proof\.mjs/,
  );
  assert.match(proof, /\.github\/workflows\/cd-npm-cli\.yml/);
  assert.match(proof, /\.github\/workflows\/cd-pwa\.yml/);
  assert.match(proof, /\.github\/workflows\/cd-npm-publish-proof\.yml/);
  assert.match(proof, /\.github\/workflows\/cd-promotion-gates-proof\.yml/);
  assert.doesNotMatch(proof, /action\.yml/);
});

test("CD promotes staged artifacts with automated gates only", () => {
  const cli = read(".github/workflows/cd-npm-cli.yml");
  const pwa = read(".github/workflows/cd-pwa.yml");
  const spec = JSON.parse(read("docs/ci/github-setup-spec.json"));
  for (const text of [cli, pwa]) {
    assert.match(text, /name: Production\n/);
    assert.match(text, /name: Main CI gate\n/);
    assert.match(text, /name: Preview.*smoke\n/);
    assert.match(text, /promotion_failed:/);
    assert.match(text, /cd-promotion-notify\.mjs/);
    assert.equal((text.match(/run: npm run build/g) ?? []).length, 1);
    assert.match(text, /cd-release-meta\.mjs write /);
    assert.match(text, /cd-release-meta\.mjs check /);
    assert.match(text, /cd-main-ci-gate\.mjs/);
    assert.match(text, /cd-preview-smoke\.mjs/);
    assert.match(text, /if: failure\(\) && !cancelled\(\)/);
    assert.equal((text.match(/promotion_failed:/g) ?? []).length, 1);
    assert.doesNotMatch(text, /self-hosted/);
    assert.match(text, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  }
  assert.doesNotMatch(pwa, /Preview gate/);
  assert.match(pwa, /name: github-pages\n/);
  assert.match(
    pwa,
    /needs: \[main_ci, proof, build, deploy, npm_preview, preview_smoke\]/,
  );
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
  assert.match(cli, /needs: \[stage, preview, preview_smoke\]/);
  assert.match(pwa, /needs: \[build, deploy, npm_preview\]/);
  const cliPreview = jobSlice(cli, "preview", "preview_smoke");
  const pwaPreview = jobSlice(pwa, "npm_preview", "deploy");
  for (const slice of [cliPreview, pwaPreview]) {
    assert.match(slice, /name: Preview npm publish\n/);
    assert.match(slice, /environment:\n {6}name: Preview\n/);
    assert.match(slice, /npm-token: \$\{\{ secrets\.NPM_TOKEN \}\}/);
    assert.match(slice, /publish-npm-package/);
  }
  const previewEnv = spec.environments.find(
    (entry) => entry.name === "Preview",
  );
  assert.ok(previewEnv.used_by.length >= 2);
  for (const envName of ["Preview", "Production", "github-pages"]) {
    assert.deepEqual(
      spec.environments.find((entry) => entry.name === envName).protection_rules
        .required_reviewers,
      [],
    );
  }
  const commands = spec.github_environment_changes_via_gh.commands.join("\n");
  assert.match(
    commands,
    /DELETE repos\/OpenSesame-Labs\/OpenSesame\/environments\/Preview\/deployment-protection-rules\/70926078/,
  );
  assert.match(
    commands,
    /DELETE repos\/OpenSesame-Labs\/OpenSesame\/environments\/Production\/deployment-protection-rules\/70926080/,
  );
  assert.doesNotMatch(commands, /"id":145080887/);
  assert.doesNotMatch(
    commands,
    /PUT repos\/OpenSesame-Labs\/OpenSesame\/environments\/Production/,
  );
  assert.match(commands, /environments\/github-pages/);
  assert.equal(spec.promotion_model.preview_smoke.includes("opensesame"), true);
  assert.match(
    spec.promotion_model.preview_smoke,
    /npm view @opensesame-labs\/cli@EXPECTED_VERSION version --prefer-online/,
  );
  assert.match(
    spec.promotion_model.preview_smoke,
    /SMOKE_REGISTRY_DEADLINE_MS/,
  );
  assert.match(spec.promotion_model.preview_smoke, /@opensesame-labs\/web-pwa/);
  assert.doesNotMatch(cli, /SMOKE_ATTEMPTS/);
  assert.doesNotMatch(pwa, /SMOKE_ATTEMPTS/);
  const cliSmoke = jobSlice(cli, "preview_smoke", "production");
  const pwaSmoke = jobSlice(pwa, "preview_smoke", "production");
  assert.match(
    cliSmoke,
    /EXPECTED_VERSION: \$\{\{ needs\.stage\.outputs\.version \}\}/,
  );
  assert.doesNotMatch(cliSmoke, /SMOKE_PUBLISHED_PACKAGE/);
  assert.match(
    pwaSmoke,
    /EXPECTED_VERSION: \$\{\{ needs\.build\.outputs\.version \}\}/,
  );
  assert.match(
    pwaSmoke,
    /SMOKE_PUBLISHED_PACKAGE: "@opensesame-labs\/web-pwa"/,
  );
  assert.deepEqual(spec.merge_queue.required_status_check_contexts, [
    "TypeScript",
    "Rust",
    "Bundle budgets",
  ]);
  const pipelines = read("docs/ci/pipelines.md");
  assert.doesNotMatch(pipelines, /only required-reviewer/);
  assert.match(pipelines, /No required reviewers/);
  assert.match(pwa, /pages-release\.mjs stamp /);
  assert.match(pwa, /proof_gate_fail:/);
  assert.match(cli, /proof_gate_fail:/);
  assert.match(cli, /CD_PROOF_GATE_FAIL:/);
  assert.match(pwa, /CD_PROOF_GATE_FAIL:/);
  const rca = read("docs/ci/post-2400-cd-failures.md");
  assert.match(rca, /41485623019/);
  assert.match(rca, /41485623157/);
  assert.match(rca, /41507534648/);
  assert.match(rca, /41507534446/);
  assert.match(rca, /ENEEDAUTH/);
  assert.match(rca, /environment Preview/);
  assert.match(rca, /pages-release\.mjs stamp/);
  assert.match(rca, /proof_gate_fail/);
  assert.match(rca, /intentional promotion gate proof failure/);
  assert.match(pipelines, /post-2400-cd-failures\.md/);
  assert.match(pipelines, /proof_gate_fail/);
  const gates = read(".github/workflows/cd-promotion-gates-proof.yml");
  assert.match(gates, /cd-production-npm-version\.test\.mjs/);
  assert.match(gates, /pull_request:/);
  assert.match(gates, /workflow_dispatch:/);
  assert.match(gates, /force_smoke_fail:/);
  assert.match(gates, /cd-promotion-notify\.test\.mjs/);
  assert.match(gates, /exit 1/);
  assert.doesNotMatch(gates, /self-hosted/);
  const ci = read(".github/workflows/ci.yml");
  for (const name of ["TypeScript", "Rust", "Bundle budgets"]) {
    assert.match(ci, new RegExp(`name: ${name}\\n`));
  }
});
