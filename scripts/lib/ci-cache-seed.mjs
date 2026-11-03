// Cache keys seeded from main.
//
// Primary keys are content-addressed. A pull request or merge queue run
// restores the primary key first. `restore-keys` then fall back to the
// `seed-main` prefix, which is saved only on push and workflow_dispatch of
// refs/heads/main. Pull requests never save. merge_group may save a primary
// key (it is a trusted ref) and must not replace the default-branch seed.
//
// npm primary:  npm-download-v2-<os>-lock-<lockfile hash>
// npm seed:     npm-download-v2-<os>-seed-main-<lockfile hash>
// npm restore:  npm-download-v2-<os>-seed-main-
//
// mise primary: mise-v2-<os>-<install slug>-lock-<mise.toml + mise.lock hash>
// mise seed:    mise-v2-<os>-seed-main-<install slug>-<same hash>
// mise restore: mise-v2-<os>-seed-main-<install slug>-
//               then the historical main prefix mise-v1-linux-
//
// Rust stays on Swatinem/rust-cache. The primary key is
// v0-rust-<job>-<os>-<arch>-<rust env>-<lock hash>. The action's restore
// key drops the lock hash (v0-rust-<job>-). Caches saved on main are visible
// to pull requests; pull requests set save-if to false.

import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const NPM_CACHE_VERSION = "npm-download-v2";
export const MISE_CACHE_VERSION = "mise-v2";
export const MISE_LEGACY_MAIN_PREFIX = "mise-v1-linux-";
export const RUST_CACHE_PREFIX = "v0-rust";

/**
 * @param {string} name
 * @param {{
 *   cacheHit?: boolean | string,
 *   matchedKey?: string,
 *   primaryKey?: string,
 *   mainSeedPrefixes?: string[],
 *   probeHasPayload?: boolean,
 * }} details
 */
export function cacheHitLine(name, details) {
  const label = `${text(name)} cache`;
  const matched = text(details.matchedKey);
  const primary = text(details.primaryKey);
  const prefixes = (details.mainSeedPrefixes ?? [])
    .map((prefix) => text(prefix))
    .filter(Boolean);
  if (details.cacheHit === true || details.cacheHit === "true") {
    return `${label}: primary key hit ${matched || primary}`;
  }
  if (matched) {
    const prefix = prefixes.find((item) => matched.startsWith(item));
    if (prefix) {
      return `${label}: restore-key fallback to main prefix ${prefix} matched ${matched}`;
    }
    return `${label}: restore-key prefix used ${matched}`;
  }
  if (details.probeHasPayload === true) {
    const prefix = prefixes[0] ?? "";
    return prefix
      ? `${label}: restore-key fallback to main prefix ${prefix}`
      : `${label}: restore-key prefix used`;
  }
  return `${label}: miss primary ${primary}`;
}

/** True when `dir` contains at least one file. A missing directory is empty. */
export function directoryHasFile(dir) {
  return walk(text(dir), 0);
}

function walk(dir, depth) {
  if (!dir || depth > 8) return false;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isFile()) return true;
    if (entry.isDirectory() && walk(join(dir, entry.name), depth + 1)) {
      return true;
    }
  }
  return false;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function prefixesFromEnv(value) {
  return text(value)
    .split(",")
    .map((prefix) => prefix.trim())
    .filter(Boolean);
}

function main() {
  const name = text(process.env.CACHE_NAME);
  if (!name) {
    console.error("ci-cache-seed: CACHE_NAME is required");
    process.exit(2);
  }
  const line = cacheHitLine(name, {
    cacheHit: process.env.CACHE_HIT,
    matchedKey: process.env.CACHE_MATCHED_KEY,
    primaryKey: process.env.CACHE_PRIMARY_KEY,
    mainSeedPrefixes: prefixesFromEnv(process.env.MAIN_SEED_PREFIX),
    probeHasPayload: directoryHasFile(process.env.CACHE_PROBE_DIR),
  });
  process.stdout.write(`${line}\n`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
