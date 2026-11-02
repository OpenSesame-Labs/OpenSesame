#!/usr/bin/env node
/**
 * Combine one entry.json per install profile and run assertProfileProof.
 *
 *   node scripts/ci/pwa-profile-proof-merge.mjs <parts-dir> <out-dir>
 *
 * Download each matrix artifact into its own directory. This walk finds
 * entry.json and `<profile>.png` under those directories.
 */

import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { WALK_NAMES } from "../../apps/pages/scripts/lib/verification-checklist-profiles.mjs";
import {
  assertProfileProof,
  proofManifest,
} from "./pwa-profile-proof-assert.mjs";

async function collect(dir, found) {
  let names;
  try {
    names = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`missing profile parts ${dir}`);
    }
    throw error;
  }
  for (const name of names) {
    const path = join(dir, name.name);
    if (name.isDirectory()) {
      await collect(path, found);
      continue;
    }
    if (name.name === "entry.json") found.entries.push(path);
    else if (name.name.endsWith(".png") && !name.name.startsWith("failure-")) {
      found.pngs.push(path);
    }
  }
}

function readEntry(text, path) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`profile entry is not JSON: ${path}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`profile entry must be an object: ${path}`);
  }
  return value;
}

export async function mergeProfileProof(partsDir, outDir) {
  const found = { entries: [], pngs: [] };
  await collect(partsDir, found);
  const parsed = [];
  for (const path of found.entries) {
    parsed.push(readEntry(await readFile(path, "utf8"), path));
  }
  if (parsed.length !== WALK_NAMES.length) {
    throw new Error(
      `expected ${WALK_NAMES.length} profile entries, found ${parsed.length}`,
    );
  }
  const ordered = [];
  for (const name of WALK_NAMES) {
    const matches = parsed.filter((entry) => entry.profile === name);
    if (matches.length !== 1) {
      throw new Error(
        `expected one entry for ${name}, found ${matches.length}`,
      );
    }
    ordered.push(matches[0]);
  }
  assertProfileProof(ordered);
  await mkdir(outDir, { recursive: true });
  for (const name of WALK_NAMES) {
    const file = `${name}.png`;
    const matches = found.pngs.filter((path) => basename(path) === file);
    if (matches.length !== 1) {
      throw new Error(`expected one ${file}, found ${matches.length}`);
    }
    await copyFile(matches[0], join(outDir, file));
  }
  const manifest = proofManifest(ordered);
  await writeFile(
    join(outDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  const parts = process.argv[2];
  const out = process.argv[3];
  if (!isPresent(parts) || !isPresent(out)) {
    console.error(
      "usage: node scripts/ci/pwa-profile-proof-merge.mjs <parts-dir> <out-dir>",
    );
    process.exit(2);
  }
  mergeProfileProof(parts, out).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

function isPresent(value) {
  return typeof value === "string" && value.length > 0;
}
