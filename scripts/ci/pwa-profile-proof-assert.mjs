/**
 * Uniqueness checks for the install-profile proof.
 *
 * `default` and `custom` share the stock build, so matching dist digests
 * are expected. The proof is the PNG: front door, the setup choice, and
 * the screen that choice reaches must not hash the same across profiles.
 *
 * This module stays free of `sharp` so the merge gate can import it
 * without an npm install.
 */

import { isString } from "../lib/json-boundary.mjs";

function hashRow(row) {
  if (!isString(row.profile) || row.profile.length === 0) {
    throw new Error("hash row needs a profile");
  }
  if (!isString(row.hash) || row.hash.length === 0) {
    throw new Error(`${row.profile} missing hash`);
  }
  if (!isString(row.label) || row.label.length === 0) {
    throw new Error("hash row needs a label");
  }
  return row;
}

/** Throw when two profiles share a hash. `label` names which image collided. */
export function assertDistinctHashes(rows) {
  const seen = new Map();
  for (const row of rows) {
    const checked = hashRow(row);
    const prior = seen.get(checked.hash);
    if (prior !== undefined) {
      throw new Error(
        `${checked.label}: ${prior} and ${checked.profile} both hash ${checked.hash}`,
      );
    }
    seen.set(checked.hash, checked.profile);
  }
}

function digestOf(entries, profile) {
  const entry = entries.find((item) => item.profile === profile);
  if (!entry || !isString(entry.distDigest) || entry.distDigest.length === 0) {
    throw new Error(`missing dist digest for ${profile}`);
  }
  return entry.distDigest;
}

/** Stock is shared. The capability-profile builds must still differ. */
export function assertDistDigests(entries) {
  const minimal = digestOf(entries, "minimal-local");
  const stock = digestOf(entries, "default");
  const custom = digestOf(entries, "custom");
  const full = digestOf(entries, "full");
  if (stock !== custom) {
    throw new Error(
      `default and custom must share the stock build (${stock} vs ${custom})`,
    );
  }
  if (new Set([minimal, stock, full]).size !== 3) {
    throw new Error(
      `minimal-local, stock, and full dists must differ: ${minimal} ${stock} ${full}`,
    );
  }
}

function switchesOf(entries, profile) {
  const entry = entries.find((item) => item.profile === profile);
  if (!entry || !Number.isInteger(entry.switchesOn)) {
    throw new Error(`missing feature switch count for ${profile}`);
  }
  return entry.switchesOn;
}

/** Minimal enables fewer feature switches than Default, and Default fewer than Full. */
export function assertFeatureSpread(entries) {
  const minimal = switchesOf(entries, "minimal-local");
  const ordinary = switchesOf(entries, "default");
  const full = switchesOf(entries, "full");
  if (minimal < ordinary && ordinary < full) return;
  throw new Error(
    `Features switches must increase minimal-local=${minimal} default=${ordinary} full=${full}`,
  );
}

function hashesOf(entries, field, label) {
  return entries.map((entry) => {
    const hash = entry[field];
    const profile = isString(entry.profile) ? entry.profile : "profile";
    if (!isString(hash) || hash.length === 0) {
      throw new Error(`missing ${field} for ${profile}`);
    }
    return { profile, hash, label };
  });
}

function ceremonyReached(entries) {
  const custom = entries.find((entry) => entry.profile === "custom");
  return custom?.ceremonyReached === true;
}

/** PNG, distinguishing screen, setup choice, dist digests, and feature spread. */
export function assertProfileProof(entries) {
  assertDistinctHashes(hashesOf(entries, "pngHash", "profile PNG"));
  assertDistinctHashes(
    hashesOf(entries, "distinguishHash", "distinguishing screenshot"),
  );
  assertDistinctHashes(hashesOf(entries, "choiceHash", "setup choice"));
  assertDistDigests(entries);
  assertFeatureSpread(entries);
  if (!ceremonyReached(entries)) {
    throw new Error("custom did not reach the capabilities ceremony");
  }
}

export function proofManifest(entries) {
  return {
    profiles: entries.map((entry) => ({
      profile: entry.profile,
      setupChoice: entry.setupChoice,
      buildKey: entry.buildKey,
      distDigest: entry.distDigest,
      pngHash: entry.pngHash,
      distinguish: entry.distinguish,
      distinguishHash: entry.distinguishHash,
      switchesOn: Number.isInteger(entry.switchesOn) ? entry.switchesOn : null,
      ceremonyReached: entry.ceremonyReached === true,
    })),
  };
}
