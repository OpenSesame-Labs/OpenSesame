#!/usr/bin/env node
// Release qualification must execute every reviewed suite on the candidate tree.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertProofFiles,
  parseRegistry,
} from "./formal-proof-push-gate-registry.mjs";
import {
  assertPinnedRequirements,
  assertRequiredRegistry,
  readRequirements,
  registryPath,
  requirementsPath,
} from "./formal-proof-required-suites.mjs";

export function runReleaseProofs(root) {
  assertProofFiles(root, {
    id: "policy",
    proofs: [registryPath, requirementsPath],
  });
  const registry = parseRegistry(readFileSync(resolve(root, registryPath)));
  const requirements = readRequirements(root);
  assertPinnedRequirements(requirements);
  assertRequiredRegistry(registry, requirements);
  assertProofFiles(root, {
    id: "axiom-controls",
    proofs: [
      "spec/formal/check-axioms.sh",
      "spec/formal/check-axioms.test.mjs",
      "spec/formal/required-theorem-command.lean",
    ],
  });
  console.log("formal proof release gate: checking axiom controls");
  // A nested Node test runner reports through IPC instead of its exit status.
  // Do not inherit that mode: this gate must observe control-test failures.
  const controlEnv = { ...process.env };
  delete controlEnv.NODE_TEST_CONTEXT;
  delete controlEnv.NODE_OPTIONS;
  const controls = spawnSync(
    process.execPath,
    ["--test", "spec/formal/check-axioms.test.mjs"],
    {
      cwd: root,
      stdio: "inherit",
      env: controlEnv,
    },
  );
  if (controls.error || controls.status !== 0)
    throw new Error("Formal proof axiom control tests failed or could not run");
  for (const suite of registry.suites) {
    assertProofFiles(root, suite);
    console.log(`formal proof release gate: checking ${suite.id}`);
    const result = spawnSync(suite.command[0], suite.command.slice(1), {
      cwd: root,
      stdio: "inherit",
      env: process.env,
    });
    if (result.error || result.status !== 0)
      throw new Error(`Formal proof suite ${suite.id} failed or could not run`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    runReleaseProofs(process.cwd());
  } catch (error) {
    console.error(`formal proof release gate: ${error.message}`);
    process.exitCode = 1;
  }
}
