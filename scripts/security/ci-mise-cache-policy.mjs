/**
 * mise-action may write GitHub Actions cache in the default-branch scope. Jobs that
 * check out workflow_call inputs (candidate source_sha) or run release/CD pipelines
 * must not restore or save that cache after untrusted checkout — see CodeQL
 * actions/cache-poisoning/poisonable-step and jdx/mise-action release guidance.
 *
 * cd-pwa.yml runs only on push to main and workflow_dispatch. cd-pwa-profile-proof.yml
 * runs on pull_request for the install-profile proof. cd-ghcr-publish.yml runs on
 * push to main, v* tags, and workflow_dispatch. None of the three uses mise-action.
 * Each may restore the trunk mise tool cache (GHCR: node and rust keys; PWA: the
 * node key) and must not save it.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const workflowDir = join(import.meta.dirname, "../../.github/workflows");

/** @param {string} name */
export function miseCacheDisabledForWorkflow(name) {
  if (
    name === "ci.yml" ||
    name === "ci-advisory.yml" ||
    name === "security.yml" ||
    name === "dev-nightly.yml" ||
    name === "cd-npm-publish-proof.yml"
  ) {
    return false;
  }
  if (/^(?:cd-|release-|candidate-)/u.test(name)) return true;
  const text = readFileSync(join(workflowDir, name), "utf8");
  return text.includes("workflow_call:");
}

/** @returns {string[]} workflow basenames where mise-action must use cache: false */
export function workflowsWithMiseCacheDisabled() {
  return readdirSync(workflowDir)
    .filter((name) => name.endsWith(".yml"))
    .filter(miseCacheDisabledForWorkflow)
    .sort();
}
