import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
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

/** Production jobs cannot publish an unqualified npm artifact. */
function assertProductionJob(text) {
  assert.doesNotMatch(text, /dist-tag add/);
  const start = text.indexOf("\n  production:");
  const end = text.indexOf("\n  promotion_failed:");
  assert.ok(start > 0 && end > start);
  const production = text.slice(start, end);
  assert.match(production, /npm publication (?:is )?disabled/i);
  assert.doesNotMatch(
    production,
    /publish-npm-package|secrets\.NPM_TOKEN|npm publish/,
  );
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

test("npm CD proves cli and web-pwa locally and drops env-spec-bridge", () => {
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
  assert.doesNotMatch(action, /npx(?:\s+-y)?\s+npm@/);
  assert.match(action, /Refuse unqualified npm publication/);
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

test("the shared action refuses publication before accessing credentials", () => {
  const actionText = read(".github/actions/publish-npm-package/action.yml");
  const action = parse(actionText);
  assert.equal(action.runs.using, "composite");
  assert.equal(action.runs.steps.length, 1);
  const guard = action.runs.steps[0];
  assert.match(guard.name, /Refuse unqualified/);
  assert.equal(guard.if, undefined);
  assert.equal(guard["continue-on-error"], undefined);
  assert.notEqual(spawnSync("bash", ["-c", guard.run]).status, 0);
  assert.doesNotMatch(
    actionText,
    /secrets\.|inputs\.npm-token|npm-trunk-publish|npm publish/,
  );
});

test("neither workflow publishes npm while candidate-bound promotion is missing", () => {
  const cli = read(".github/workflows/cd-npm-cli.yml");
  const pwa = read(".github/workflows/cd-pwa.yml");
  const action = read(".github/actions/publish-npm-package/action.yml");
  const spec = JSON.parse(read("docs/ci/github-setup-spec.json"));
  for (const text of [cli, pwa]) assertProductionJob(text);
  assert.match(action, /npm publication is disabled/i);
  assert.doesNotMatch(action, /npm-trunk-publish\.mjs|inputs\.npm-token/);
  assert.match(spec.promotion_model.production, /npm publication is disabled/i);
  assert.match(spec.promotion_model.preview, /local/i);
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
  assert.match(dry, /"--dry-run",\s*"--ignore-scripts"/);
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

test("staged npm packages are checked locally while Pages smoke remains active", () => {
  const cli = read(".github/workflows/cd-npm-cli.yml");
  const pwa = read(".github/workflows/cd-pwa.yml");
  const stage = jobSlice(cli, "stage", "preview");
  const preview = jobSlice(cli, "preview", "preview_smoke");
  const smoke = jobSlice(cli, "preview_smoke", "production");
  const pwaPreview = jobSlice(pwa, "npm_preview", "deploy");
  const pwaSmoke = jobSlice(pwa, "preview_smoke", "production");
  assert.match(stage, /CLI_RELEASE_PACK: "1"/);
  assert.match(stage, /npm publish --dry-run/);
  assert.match(preview, /npm-local-package-smoke\.mjs/);
  assert.match(smoke, /npm-local-package-smoke\.mjs.*--run-cli/);
  assert.match(pwaPreview, /npm-local-package-smoke\.mjs/);
  assert.match(pwaSmoke, /cd-pwa-preview-smoke\/run\.mjs/);
  assert.doesNotMatch(pwaSmoke, /CD_REGISTRY_VERSION_CONFIRMED/);
  assert.doesNotMatch(
    read("scripts/release/cd-pwa-preview-smoke/run.mjs"),
    /runHurl\("registry\.hurl"/,
  );
  assert.match(
    read("scripts/release/cd-pwa-preview-smoke/run.mjs"),
    /runHurl\("pages\.hurl"/,
  );
  assert.match(
    read("scripts/release/prepare-cli-release.mjs"),
    /!dist\/\*\*\/\*\.map/,
  );
  assert.match(
    read(".github/workflows/cd-ghcr-publish.yml"),
    /cli-shrinkwrap\.mjs check/,
  );
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
