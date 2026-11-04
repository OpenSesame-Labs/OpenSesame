/**
 * Assemble provider key prefixes and scan text for them.
 * Source keeps the vendor stem in parts so the contiguous prefix is never committed.
 */

const VENDOR_PARTS = ["ts", "key"];
const KINDS = ["api", "client", "auth"];

/** Five-letter vendor stem, assembled at runtime. */
export function tailscaleVendorStem() {
  return VENDOR_PARTS.join("");
}

/** Vendor stem plus the separator that starts every provider key. */
export function tailscaleKeyPrefix() {
  return `${tailscaleVendorStem()}-`;
}

/**
 * @param {string} kind `api`, `client`, or `auth`
 * @returns {string} kind prefix, including the trailing separator
 */
export function tailscaleKindPrefix(kind) {
  return `${tailscaleKeyPrefix()}${kind}-`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Contiguous kind prefixes (`api`, `client`, `auth`). */
export function tailscaleKindPrefixPattern() {
  const alternatives = KINDS.map((kind) =>
    escapeRegExp(tailscaleKindPrefix(kind)),
  ).join("|");
  return new RegExp(alternatives, "u");
}

/** @param {string} text */
export function textHasTailscaleKeyMaterial(text) {
  return tailscaleKindPrefixPattern().test(text);
}

/**
 * @param {string} text
 * @returns {number[]} 1-based line numbers that embed a kind prefix
 */
export function tailscaleKeyMaterialLines(text) {
  const pattern = tailscaleKindPrefixPattern();
  const hits = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (pattern.test(lines[index] ?? "")) hits.push(index + 1);
  }
  return hits;
}
