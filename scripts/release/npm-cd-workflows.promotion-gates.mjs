/** Shared assertions for local npm proofs and the existing Pages deployment. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

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
function workflow(text) {
  return parse(text);
}
function noRegistryPublication(text) {
  const jobs = workflow(text).jobs;
  for (const [name, job] of Object.entries(jobs)) {
    if (name !== "deploy")
      assert.notEqual(job.permissions?.["id-token"], "write");
    for (const step of job.steps ?? []) {
      assert.doesNotMatch(String(step.uses ?? ""), /publish-npm-package/);
      assert.doesNotMatch(
        String(step.run ?? ""),
        /npm\s+publish(?!\s+--dry-run\b)/,
      );
      assert.doesNotMatch(JSON.stringify(step), /secrets\.NPM_TOKEN/);
      assert.doesNotMatch(String(step.run ?? ""), /npm-trunk-publish\.mjs/);
    }
  }
}
export function assertAutomatedGates(cli, pwa) {
  for (const text of [cli, pwa]) {
    assert.match(text, /name: Main CI gate/);
    assert.match(text, /promotion_failed:/);
    assert.match(text, /cd-promotion-notify\.mjs/);
    assert.match(text, /cd-release-meta\.mjs write /);
    assert.match(text, /cd-release-meta\.mjs check /);
    assert.match(text, /cd-main-ci-gate\.mjs/);
    assert.match(text, /if: failure\(\) && !cancelled\(\)/);
    assert.doesNotMatch(text, /self-hosted/);
    noRegistryPublication(text);
  }
}
export function assertStagedArtifactsBuiltOnce(cli, pwa) {
  assert.equal((cli.match(/run: npm run build/g) ?? []).length, 1);
  assert.match(cli, /CLI_RELEASE_PACK: "1"/);
  assert.match(pwa, /ci-pages-build\.mjs/);
  assert.match(cli, /npm publish --dry-run --ignore-scripts/);
  assert.match(pwa, /npm publish --dry-run --ignore-scripts/);
  assert.match(cli, /npm-local-package-smoke\.mjs/);
  assert.match(pwa, /npm-local-package-smoke\.mjs/);
  assert.match(pwa, /pwa-full-profile-dist-\$\{\{ github\.run_id \}\}/);
}
export function assertPwaJobGraph(pwa) {
  const jobs = workflow(pwa).jobs;
  assert.deepEqual(jobs.deploy.needs, ["main_ci", "build", "proof"]);
  assert.deepEqual(jobs.preview_smoke.needs, [
    "main_ci",
    "build",
    "deploy",
    "npm_preview",
  ]);
  assert.deepEqual(jobs.production.needs, [
    "main_ci",
    "proof",
    "build",
    "deploy",
    "npm_preview",
    "preview_smoke",
  ]);
  assert.equal(jobs.deploy.environment.name, "github-pages");
  assert.equal(jobs.deploy.permissions.pages, "write");
  assert.equal(jobs.deploy.permissions["id-token"], "write");
  assert.match(
    jobSlice(pwa, "production", "promotion_failed"),
    /pages-release\.mjs verify/,
  );
  assert.match(pwa, /pwa-full-profile-dist-build\.mjs/);
  assert.match(pwa, /cd-pwa-pages-workspace-install\.mjs/);
}
export function assertPreviewPublishJobs(cli, pwa) {
  for (const [text, id] of [
    [cli, "preview"],
    [pwa, "npm_preview"],
  ]) {
    const job = workflow(text).jobs[id];
    assert.equal(job.environment, undefined);
    assert.equal(job.permissions["id-token"], undefined);
    assert.match(
      job.steps.map((step) => step.run ?? "").join("\n"),
      /npm-local-package-smoke\.mjs/,
    );
  }
}
export function assertSpecEnvironmentChanges(spec) {
  assert.match(spec.promotion_model.preview, /local/i);
  assert.match(spec.promotion_model.production, /npm publication is disabled/i);
  assert.ok(spec.environments.some((entry) => entry.name === "github-pages"));
}
export function assertPreviewSmokeJobs(cli, pwa) {
  const cliSmoke = jobSlice(cli, "preview_smoke", "production");
  const pwaSmoke = jobSlice(pwa, "preview_smoke", "production");
  assert.match(cliSmoke, /npm-local-package-smoke\.mjs.*--run-cli/);
  assert.match(cliSmoke, /CD_PROOF_GATE_FAIL/);
  assert.match(pwaSmoke, /cd-pwa-preview-smoke\/run\.mjs/);
  assert.match(pwaSmoke, /CD_PROOF_GATE_FAIL/);
  assert.match(pwaSmoke, /STAGED_DIST: apps\/pages\/dist/);
  assert.match(pwaSmoke, /ensure-chrome-headless-shell\.mjs/);
  assert.match(pwaSmoke, /cd-pwa-preview-smoke-\$\{\{ github\.run_id \}\}/);
  assert.doesNotMatch(pwaSmoke, /CD_REGISTRY_VERSION_CONFIRMED/);
}
export function assertPromotionDocs(cli, pwa, spec) {
  assert.deepEqual(spec.merge_queue.required_status_check_contexts, [
    "TypeScript",
    "Rust",
    "Bundle budgets",
  ]);
  assert.match(read("docs/ci/pipelines.md"), /npm publication is disabled/i);
  assert.match(cli, /proof_gate_fail:/);
  assert.match(pwa, /proof_gate_fail:/);
  assert.match(pwa, /pages-release\.mjs stamp/);
}
export function assertGatesProofAndCiChecks() {
  const gates = read(".github/workflows/cd-promotion-gates-proof.yml");
  assert.match(gates, /cd-production-npm-version\.test\.mjs/);
  assert.match(gates, /pull_request:/);
  assert.match(gates, /workflow_dispatch:/);
  assert.match(gates, /force_smoke_fail:/);
  assert.match(gates, /cd-promotion-notify\.test\.mjs/);
  assert.match(gates, /exit 1/);
  const ci = read(".github/workflows/ci.yml");
  for (const name of ["TypeScript", "Rust", "Bundle budgets"])
    assert.match(ci, new RegExp(`name: ${name}\\n`));
}
