/**
 * Composite PNG for the install-profile proof.
 * Distinctness checks live in `pwa-profile-proof-assert.mjs` so the merge
 * gate can run them without `sharp`.
 */

import { writeFile } from "node:fs/promises";
import sharp from "sharp";

export {
  assertDistinctHashes,
  assertDistDigests,
  assertFeatureSpread,
  assertFullProfileProof,
  assertProfileProof,
  proofManifest,
} from "./pwa-profile-proof-assert.mjs";

const GAP = 16;
const LABEL_HEIGHT = 40;

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
