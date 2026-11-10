import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertAutomatedGates,
  assertGatesProofAndCiChecks,
  assertPreviewPublishJobs,
  assertPreviewSmokeJobs,
  assertPromotionDocs,
  assertPwaJobGraph,
  assertSpecEnvironmentChanges,
  assertStagedArtifactsBuiltOnce,
  jobSlice,
  read,
  root,
} from "./npm-cd-workflows.promotion-gates.mjs";
import { CD_PRODUCTION_DIST_TAG } from "./npm-prerelease-version.mjs";

/** Production job: checks meta, rewrites to next, publishes with NPM_TOKEN. */
function assertProductionJob(text) {
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

/** Trusted publishers cover both packages in Preview and Production. */
function assertTrustedPublishers(spec) {
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
  assert.match(pwa, /group: cd-pwa\n {2}cancel-in-progress: false/);
  assert.doesNotMatch(cli, /cancel-in-progress: false/);
  assert.doesNotMatch(pwa, /cancel-in-progress: true/);
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
  for (const text of [cli, pwa]) assertProductionJob(text);
  assert.match(action, /0\.0\.0-next\.N/);
  assert.match(action, /npm-trunk-publish\.mjs/);
  assert.match(read("scripts/release/npm-trunk-publish.mjs"), /--provenance/);
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
  assertTrustedPublishers(spec);
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
  assertAutomatedGates(cli, pwa);
  assertStagedArtifactsBuiltOnce(cli, pwa);
  assertPwaJobGraph(pwa);
  assertPreviewPublishJobs(cli, pwa, spec);
  assertSpecEnvironmentChanges(spec);
  assertPreviewSmokeJobs(cli, pwa);
  assertPromotionDocs(cli, pwa, spec);
  assertGatesProofAndCiChecks();
});

test("CLI publish drops sourcemaps and confirms the registry version before smoke", () => {
  const cli = read(".github/workflows/cd-npm-cli.yml");
  const pwa = read(".github/workflows/cd-pwa.yml");
  const stage = jobSlice(cli, "stage", "preview");
  const preview = jobSlice(cli, "preview", "preview_smoke");
  const smoke = jobSlice(cli, "preview_smoke", "production");
  const pwaPreview = jobSlice(pwa, "npm_preview", "deploy");
  const pwaSmoke = jobSlice(pwa, "preview_smoke", "production");
  assert.match(stage, /CLI_RELEASE_PACK: "1"\n/);
  assert.match(stage, /npm run build -w @opensesame\/cli\n/);
  assert.equal((cli.match(/run: npm run build/g) ?? []).length, 1);
  const publishAt = preview.lastIndexOf("publish-npm-package");
  const waitAt = preview.indexOf("scripts/release/cd-registry-wait.mjs");
  assert.ok(publishAt > 0 && waitAt > publishAt);
  assert.match(
    preview,
    /EXPECTED_VERSION: \$\{\{ needs\.stage\.outputs\.version \}\}/,
  );
  assert.doesNotMatch(cli, /SMOKE_REGISTRY_DEADLINE_MS/);
  assert.doesNotMatch(cli, /SMOKE_REGISTRY_POLL_MS/);
  assert.match(
    smoke,
    /CD_REGISTRY_VERSION_CONFIRMED: \$\{\{ needs\.preview\.result == 'success' && '1' \|\| '' \}\}/,
  );
  assert.match(smoke, /cd-preview-smoke\.mjs/);
  const pwaPublishAt = pwaPreview.lastIndexOf("publish-npm-package");
  const pwaWaitAt = pwaPreview.indexOf("scripts/release/cd-registry-wait.mjs");
  assert.ok(pwaPublishAt > 0 && pwaWaitAt > pwaPublishAt);
  assert.match(
    pwaPreview,
    /EXPECTED_VERSION: \$\{\{ needs\.build\.outputs\.version \}\}/,
  );
  assert.match(pwaPreview, /SMOKE_REGISTRY_DEADLINE_MS: "900000"/);
  assert.doesNotMatch(cli, /SMOKE_REGISTRY_DEADLINE_MS/);
  assert.match(
    pwaSmoke,
    /CD_REGISTRY_VERSION_CONFIRMED: \$\{\{ needs\.npm_preview\.result == 'success' && '1' \|\| '' \}\}/,
  );
  assert.doesNotMatch(pwa, /CLI_RELEASE_PACK/);
  const wait = read("scripts/release/cd-registry-wait.mjs");
  assert.match(wait, /waitForPublishedVersion/);
  assert.match(wait, /registryBudget/);
  const prepare = read("scripts/release/prepare-cli-release.mjs");
  assert.match(prepare, /!dist\/\*\*\/\*\.map/);
  assert.match(prepare, /cliPublishDependencies/);
  const ghcr = read(".github/workflows/cd-ghcr-publish.yml");
  assert.match(ghcr, /cli-shrinkwrap\.mjs check/);
  const publishAction = read(".github/actions/publish-npm-package/action.yml");
  assert.match(publishAction, /npm-trunk-publish\.mjs/);
  const build = read("packages/cli/scripts/build.mjs");
  assert.match(build, /CLI_RELEASE_PACK === "1"/);
  assert.match(build, /sourcemap: !releasePack/);
});

test("CLI gate polls every 5s and stage overlaps it without a shorter deadline", () => {
  const cli = read(".github/workflows/cd-npm-cli.yml");
  const gate = read("scripts/release/cd-main-ci-gate.mjs");
  const mainCi = jobSlice(cli, "main_ci", "stage");
  const stage = jobSlice(cli, "stage", "preview");
  const preview = jobSlice(cli, "preview", "preview_smoke");
  assert.match(mainCi, /CI_GATE_INTERVAL_MS: "5000"\n/);
  assert.match(mainCi, /CI_GATE_ATTEMPTS: "475"\n/);
  assert.match(mainCi, /node scripts\/release\/cd-main-ci-gate\.mjs/);
  assert.match(gate, /readCount\(env\.CI_GATE_ATTEMPTS, 80,/);
  assert.match(gate, /readDelay\(env\.CI_GATE_INTERVAL_MS, 30_000\)/);
  assert.equal((475 - 1) * 5000, (80 - 1) * 30_000);
  assert.deepEqual(
    ["TypeScript", "Rust", "Bundle budgets"].every((name) =>
      gate.includes(`"${name}"`),
    ),
    true,
  );
  assert.doesNotMatch(stage, /\n {4}needs:/);
  assert.match(preview, /needs: \[stage, main_ci\]/);
  assert.doesNotMatch(cli, /uses:\s+actions\/cache@/);
  assert.doesNotMatch(cli, /actions\/cache\/save@/);
  assert.match(
    cli,
    /actions\/cache\/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9/,
  );
  assert.match(cli, /path: ~\/\.local\/share\/mise/);
  assert.doesNotMatch(cli, /TRUSTED_CACHE_SAVE:/);
  assert.doesNotMatch(cli, /path: node_modules/);
});
