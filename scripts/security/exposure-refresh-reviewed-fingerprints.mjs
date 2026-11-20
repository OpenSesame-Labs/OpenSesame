#!/usr/bin/env node
/**
 * Update reviewed source fingerprints in tools/security/exposure-matrix.json
 * after deliberate re-review. Uses the same digest encoding as the exposure gate.
 *
 * Patches only the matching `sources` entry so the rest of the matrix file
 * (including surfaces formatting) is preserved byte-for-byte.
 *
 * Usage: node scripts/security/exposure-refresh-reviewed-fingerprints.mjs PATH...
 * Then: npm run audit:exposure
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  encodeSourceDigest,
  POLICY_PATH,
  parsePolicy,
} from "../lib/exposure-policy.mjs";

function sha256File(root, rel) {
  const abs = resolve(root, rel);
  return createHash("sha256").update(readFileSync(abs)).digest("hex");
}

function patchSourceDigestInPlace(text, rel, chunks) {
  const sourcesKey = '"sources":';
  const sourcesIdx = text.indexOf(sourcesKey);
  if (sourcesIdx < 0) {
    throw new Error(`EM-SOURCE: missing sources map in ${POLICY_PATH}`);
  }
  const needle = `"${rel}"`;
  const keyIdx = text.indexOf(needle, sourcesIdx);
  if (keyIdx < 0) {
    throw new Error(`EM-SOURCE: ${rel} is not present in ${POLICY_PATH}`);
  }
  const open = text.indexOf("[", keyIdx);
  if (open < 0) {
    throw new Error(`EM-SOURCE: malformed sources entry for ${rel}`);
  }
  let depth = 0;
  let close = open;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (depth !== 0) {
    throw new Error(`EM-SOURCE: unclosed array for ${rel}`);
  }
  const lineStart = text.lastIndexOf("\n", keyIdx) + 1;
  const keyLine = text.slice(lineStart, open);
  const innerIndent = keyLine.match(/^(\s+)/)?.[1]
    ? `${keyLine.match(/^(\s+)/)[1]}  `
    : "      ";
  const closeIndent =
    text.slice(close).match(/\n(\s*)\]/)?.[1] ??
    keyLine.match(/^(\s+)/)?.[1] ??
    "    ";
  const inner = chunks.map((part) => `${innerIndent}"${part}"`).join(",\n");
  const replacement = `[\n${inner}\n${closeIndent}]`;
  return text.slice(0, open) + replacement + text.slice(close + 1);
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
  const raw = readFileSync(policyPath);
  const policy = parsePolicy(raw);
  let text = raw.toString("utf8");
  for (const rel of paths) {
    if (!Object.hasOwn(policy.sources, rel)) {
      console.error(`EM-SOURCE: ${rel} is not a reviewed source binding`);
      process.exitCode = 1;
      return;
    }
    const hex = sha256File(root, rel);
    const chunks = encodeSourceDigest(hex);
    text = patchSourceDigestInPlace(text, rel, chunks);
    policy.sources[rel] = chunks;
    console.error(`updated ${rel} -> ${hex.slice(0, 16)}…`);
  }
  const next = text.endsWith("\n") ? text : `${text}\n`;
  parsePolicy(Buffer.from(next, "utf8"));
  writeFileSync(policyPath, next);
  console.error(`wrote ${POLICY_PATH}`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}