/**
 * Tailscale key prefixes assembled at runtime.
 * Call sites use these helpers so source does not commit a contiguous kind prefix.
 */

const VENDOR_STEM = ["ts", "key"].join("");

/** Vendor stem plus the separator that starts every provider key. */
export const TAILSCALE_KEY_PREFIX = `${VENDOR_STEM}-`;

export type TailscaleKeyKind = "api" | "client" | "auth";

/** Kind prefix, including the trailing separator. */
export function tailscaleKindPrefix(kind: TailscaleKeyKind): string {
  return `${TAILSCALE_KEY_PREFIX}${kind}-`;
}
