/**
 * mise-action may write GitHub Actions cache in the default-branch scope. Jobs that
 * check out workflow_call inputs (candidate source_sha) or run release/CD pipelines
 * must not restore or save that cache after untrusted checkout — see CodeQL
 * actions/cache-poisoning/poisonable-step and jdx/mise-action release guidance.
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
