/**
 * Uniqueness checks and the composite for the install-profile proof.
 *
 * `default` and `custom` share the stock build, so matching dist digests
 * are expected. The proof is the PNG: front door, the setup choice, and
 * the screen that choice reaches must not hash the same across profiles.
 */

import { writeFile } from "node:fs/promises";
import sharp from "sharp";
import { isString } from "../lib/json-boundary.mjs";

const GAP = 16;
const LABEL_HEIGHT = 40;

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

function pixelSize(meta, path) {
  const width = meta.width;
  const height = meta.height;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1
  ) {
    throw new Error(`screenshot has no pixel size: ${path}`);
  }
  return { width, height };
}

export async function readImageWidth(path) {
  const size = pixelSize(await sharp(path).metadata(), path);
  return size.width;
}

export async function widenTo(path, width) {
  const size = pixelSize(await sharp(path).metadata(), path);
  if (size.width === width) return;
  const buffer = await sharp(path).resize({ width }).png().toBuffer();
  await writeFile(path, buffer);
}

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function labelSvg(width, text) {
  const label = escapeXml(text);
  return Buffer.from(
    `<svg width="${width}" height="${LABEL_HEIGHT}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#102033"/><text x="16" y="26" fill="#d7e6f5" font-family="DejaVu Sans, sans-serif" font-size="18">${label}</text></svg>`,
  );
}

async function loadPanels(panels) {
  const loaded = [];
  for (const panel of panels) {
    const size = pixelSize(await sharp(panel.path).metadata(), panel.path);
    loaded.push({ label: panel.label, path: panel.path, ...size });
  }
  return loaded;
}

async function panelBuffer(panel, width) {
  if (panel.width === width) return sharp(panel.path).png().toBuffer();
  return sharp(panel.path)
    .extend({
      right: width - panel.width,
      background: { r: 16, g: 32, b: 51, alpha: 1 },
    })
    .png()
    .toBuffer();
}

/** Stack labeled screenshots into one PNG. */
export async function stitchPanels(panels, destination) {
  if (panels.length === 0) throw new Error("stitch needs a panel");
  const loaded = await loadPanels(panels);
  const width = Math.max(...loaded.map((panel) => panel.width));
  const layers = [];
  let cursor = 0;
  for (const panel of loaded) {
    layers.push({ input: labelSvg(width, panel.label), top: cursor, left: 0 });
    cursor += LABEL_HEIGHT;
    layers.push({
      input: await panelBuffer(panel, width),
      top: cursor,
      left: 0,
    });
    cursor += panel.height + GAP;
  }
  await sharp({
    create: {
      width,
      height: cursor - GAP,
      channels: 4,
      background: { r: 8, g: 16, b: 28, alpha: 1 },
    },
  })
    .composite(layers)
    .png()
    .toFile(destination);
}
