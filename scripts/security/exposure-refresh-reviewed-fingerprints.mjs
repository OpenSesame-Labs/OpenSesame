#!/usr/bin/env node
/**
 * Update reviewed source fingerprints in tools/security/exposure-matrix.json
 * after deliberate re-review. Uses the same digest encoding as the exposure gate.
 *
 * Usage: node scripts/security/exposure-refresh-reviewed-fingerprints.mjs PATH...
 * Then: npm run audit:exposure
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeSourceDigest, POLICY_PATH, parsePolicy } from "../lib/exposure-policy.mjs";

function sha256File(root, rel) {
  const abs = resolve(root, rel);
  return createHash("sha256").update(readFileSync(abs)).digest("hex");
}

function main() {
  const paths = process.argv.slice(2);
  if (!paths.length) {
    console.error(
      "usage: exposure-refresh-reviewed-fingerprints.mjs <reviewed-source-path>...",
    );
    process.exitCode = 1;
    return;
  }
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const policyPath = resolve(root, POLICY_PATH);
  const policy = parsePolicy(readFileSync(policyPath));
  for (const rel of paths) {
    if (!Object.hasOwn(policy.sources, rel)) {
      console.error(`EM-SOURCE: ${rel} is not a reviewed source binding`);
      process.exitCode = 1;
      return;
    }
    const hex = sha256File(root, rel);
    policy.sources[rel] = encodeSourceDigest(hex);
    console.error(`updated ${rel} -> ${hex.slice(0, 16)}…`);
  }
  writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
  console.error(`wrote ${POLICY_PATH}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}