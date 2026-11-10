/**
 * Shared readers and the assertion groups behind the
 * "CD promotes staged artifacts with automated gates only" test in
 * `npm-cd-workflows.test.mjs`. Each group covers one part of the promotion
 * chain, in the order that test calls them.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const root = join(import.meta.dirname, "../..");

export function read(path) {
  return readFileSync(join(root, path), "utf8");
}

export function jobSlice(text, jobKey, nextJobKey) {
  const start = text.indexOf(`\n  ${jobKey}:`);
  const end = text.indexOf(`\n  ${nextJobKey}:`);
  assert.ok(start > 0 && end > start);
  return text.slice(start, end);
}

/** Both CD workflows carry every automated gate and one failure notifier. */
export function assertAutomatedGates(cli, pwa) {
  for (const text of [cli, pwa]) {
    assert.match(text, /name: Production\n/);
    assert.match(text, /name: Main CI gate\n/);
    assert.match(text, /name: Preview.*smoke\n/);
    assert.match(text, /promotion_failed:/);
    assert.match(text, /cd-promotion-notify\.mjs/);
    assert.match(text, /cd-release-meta\.mjs write /);
    assert.match(text, /cd-release-meta\.mjs check /);
    assert.match(text, /cd-main-ci-gate\.mjs/);
    assert.match(text, /cd-preview-smoke\.mjs/);
    assert.match(text, /if: failure\(\) && !cancelled\(\)/);
    assert.equal((text.match(/promotion_failed:/g) ?? []).length, 1);
    assert.doesNotMatch(text, /self-hosted/);
    assert.match(text, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  }
}

/** Each workflow builds once and later jobs reuse the staged artifacts. */
export function assertStagedArtifactsBuiltOnce(cli, pwa) {
  assert.equal((cli.match(/run: npm run build/g) ?? []).length, 1);
  assert.match(pwa, /ci-pages-build\.mjs/);
  assert.doesNotMatch(pwa, /run: npm run build -w @opensesame\/pages/);
  assert.doesNotMatch(pwa, /Preview gate/);
  assert.match(pwa, /name: github-pages\n/);
  assert.match(
    pwa,
    /needs: \[main_ci, proof, build, deploy, npm_preview, preview_smoke\]/,
  );
  assert.match(pwa, /name: Build full install profile dist/);
  assert.match(pwa, /pwa-full-profile-dist-\$\{\{ github\.run_id \}\}/);
  assert.match(pwa, /cd-pwa-pages-workspace-install\.mjs/);
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
    4,
  );
  assert.equal(
    (pwa.match(/pages-dist-\$\{\{ github\.run_id \}\}/g) ?? []).length,
    3,
  );
  assert.match(cli, /needs: \[stage, preview\]/);
  assert.match(cli, /needs: \[stage, preview, preview_smoke\]/);
  assert.match(pwa, /needs: \[main_ci, build, deploy, npm_preview\]/);
}

/** PWA job graph: proof, builds, preview, deploy, and production wiring. */
export function assertPwaJobGraph(pwa) {
  const pwaBuild = jobSlice(pwa, "build", "npm_preview");
  const pwaBuildFull = jobSlice(pwa, "build_full_profile", "proof");
  const pwaProof = jobSlice(pwa, "proof", "build");
  const pwaPreview = jobSlice(pwa, "npm_preview", "deploy");
  const pwaDeploy = jobSlice(pwa, "deploy", "preview_smoke");
  assert.doesNotMatch(pwaProof, /needs: main_ci/);
  assert.match(pwaProof, /needs: \[build_full_profile\]/);
  assert.match(pwaProof, /PWA_PROFILE_PROOF_DIST/);
  assert.doesNotMatch(pwaProof, /playwright install --with-deps/);
  assert.match(pwaBuildFull, /pwa-full-profile-dist-build\.mjs/);
  assert.match(pwaBuildFull, /needs: \[main_ci\]/);
  assert.match(
    pwaBuildFull,
    /ci-pwa-full-profile-dist-\$\{\{ steps\.main_ci_run\.outputs\.run_id \}\}/,
  );
  assert.match(pwaBuildFull, /cd-resolve-main-ci-run\.mjs/);
  assert.doesNotMatch(pwaBuildFull, /playwright install/);
  assert.doesNotMatch(pwaBuild, /needs: main_ci/);
  assert.match(pwaBuild, /ci-pages-build\.mjs/);
  assert.match(pwaPreview, /needs: \[main_ci, build, proof\]/);
  assert.match(pwaDeploy, /needs: \[main_ci, build, proof\]/);
  assert.match(pwaPreview, /actions\/download-artifact@/);
  assert.match(pwaPreview, /npm-pages-pwa-release-\$\{\{ github\.run_id \}\}/);
  assert.doesNotMatch(pwaPreview, /npm run build/);
  const pwaProduction = jobSlice(pwa, "production", "promotion_failed");
  assert.match(pwaProduction, /actions\/download-artifact@/);
  assert.match(pwaProduction, /pages-dist-\$\{\{ github\.run_id \}\}/);
  assert.match(
    pwaProduction,
    /npm-pages-pwa-release-\$\{\{ github\.run_id \}\}/,
  );
  assert.match(pwaProduction, /npm-token: \$\{\{ secrets\.NPM_TOKEN \}\}/);
  assert.match(pwaProduction, /npm-dist-tag: next/);
  assert.doesNotMatch(pwaProduction, /npm run build/);
}

/** Preview publish jobs use environment Preview, and no reviewer gates one. */
export function assertPreviewPublishJobs(cli, pwa, spec) {
  const pwaPreview = jobSlice(pwa, "npm_preview", "deploy");
  const cliPreview = jobSlice(cli, "preview", "preview_smoke");
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
}

/** Setup spec: reviewer rules are deleted and the smoke model is described. */
export function assertSpecEnvironmentChanges(spec) {
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
  assert.match(spec.promotion_model.preview_smoke, /Hurl 8\.1\.0 HTTP asserts/);
  assert.match(
    spec.promotion_model.preview_smoke,
    /SMOKE_REGISTRY_DEADLINE_MS/,
  );
  assert.match(spec.promotion_model.preview_smoke, /@opensesame-labs\/web-pwa/);
}

/** Preview smoke jobs: env wiring, locked tools, and no cache writes. */
export function assertPreviewSmokeJobs(cli, pwa) {
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
    /CD_REGISTRY_VERSION_CONFIRMED: \$\{\{ needs\.npm_preview\.result == 'success' && '1' \|\| '' \}\}/,
  );
  assert.match(pwaSmoke, /cd-pwa-preview-smoke\/run\.mjs/);
  assert.match(
    pwaSmoke,
    /bash scripts\/lib\/install-mise-locked\.sh node@24 hurl@8\.1\.0/,
  );
  assert.doesNotMatch(pwaSmoke, /install_args:/);
  assert.doesNotMatch(pwaSmoke, /cd-preview-smoke\.mjs/);
  assert.match(pwaSmoke, /pages-dist-\$\{\{ github\.run_id \}\}/);
  assert.match(pwaSmoke, /STAGED_DIST: apps\/pages\/dist/);
  assert.match(pwaSmoke, /SMOKE_EVIDENCE_OUT: artifacts\/cd-pwa-preview-smoke/);
  assert.match(pwaSmoke, /ensure-chrome-headless-shell\.mjs/);
  assert.doesNotMatch(pwaSmoke, /uses:\s+actions\/cache@/);
  assert.doesNotMatch(pwaSmoke, /actions\/cache\/save@/);
  assert.match(
    pwaSmoke,
    /actions\/cache\/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9/,
  );
  assert.match(pwaSmoke, /path: ~\/\.local\/share\/mise/);
  assert.doesNotMatch(pwa, /jdx\/mise-action/);
  assert.doesNotMatch(pwa, /uses:\s+actions\/cache@/);
  assert.doesNotMatch(pwa, /actions\/cache\/save@/);
  assert.doesNotMatch(pwa, /^[ \t]+cache:[ \t]+true[ \t]*$/m);
  assert.match(
    pwa,
    /actions\/cache\/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9/,
  );
  assert.doesNotMatch(pwaSmoke, /npx playwright install chromium/);
  assert.match(pwaSmoke, /cd-pwa-preview-smoke-\$\{\{ github\.run_id \}\}/);
}

/** Required checks, the proof-gate switch, and the docs that record them. */
export function assertPromotionDocs(cli, pwa, spec) {
  const proofPaths = read(".github/workflows/cd-npm-publish-proof.yml");
  assert.match(proofPaths, /scripts\/release\/cd-registry-wait\.mjs/);
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
}

/** The gates proof workflow and the required CI check names. */
export function assertGatesProofAndCiChecks() {
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
}
