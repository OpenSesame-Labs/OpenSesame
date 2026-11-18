import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PINNED_FORMAL_SUITES } from "./formal-proof-pinned-suites.mjs";
import { parseRegistry } from "./formal-proof-push-gate-registry.mjs";

export const registryPath = "spec/formal/proof-registry.json";
export const requirementsPath = "spec/formal/proof-requirements.json";

// Requirements are data: historical commits are parsed, never imported.
export function parseRequirements(bytes) {
  try {
    return parseRegistry(bytes);
  } catch {
    throw new Error("Invalid formal proof requirements JSON or suite");
  }
}

export function readRequirements(root) {
  return parseRequirements(readFileSync(resolve(root, requirementsPath)));
}

function sameMembers(actual, expected) {
  return (
    actual.length === expected.length &&
    expected.every((item) => actual.includes(item))
  );
}

function sameProjection(actual, expected, fields) {
  if (!actual || !expected) return !actual && !expected;
  return fields.every((field) => actual[field] === expected[field]);
}

export function sameProofContract(actual, expected) {
  return (
    sameMembers(actual.proofs, expected.proofs) &&
    actual.command.length === expected.command.length &&
    expected.command.every((item, index) => actual.command[index] === item) &&
    sameProjection(actual.lockProjection, expected.lockProjection, [
      "path",
      "root",
      "dependency",
    ]) &&
    sameProjection(actual.manifestProjection, expected.manifestProjection, [
      "path",
      "package",
      "lock",
      "root",
    ])
  );
}

export function assertRequiredRegistry(registry, requirements) {
  for (const required of requirements.suites) {
    const suite = registry.suites.find((entry) => entry.id === required.id);
    if (!suite)
      throw new Error(`Required formal proof suite ${required.id} is missing`);
    if (
      !sameMembers(suite.implementation, required.implementation) ||
      !sameProofContract(suite, required)
    )
      throw new Error(
        `Formal proof suite ${suite.id} does not match required mappings, proofs, or command`,
      );
  }
  if (registry.suites.length !== requirements.suites.length)
    throw new Error("Formal proof registry contains an unpinned suite");
}

export function assertPinnedRequirements(requirements) {
  assertRequiredRegistry(requirements, { suites: PINNED_FORMAL_SUITES });
}
