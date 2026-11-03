/** CD and pull-request proof use the full install profile only. */
export const FULL_INSTALL_PROFILE_PROOF_NAME = "full";

/**
 * Choose which install-profile walks a proof process builds.
 * CD workflows set `PWA_PROFILE_PROOF_NAME=full`. An empty request keeps every walk for local runs.
 */

import { isString } from "../lib/json-boundary.mjs";

export function walksForProof(walks, requested) {
  if (!Array.isArray(walks) || walks.length === 0) {
    throw new Error("profile proof needs walks");
  }
  if (!isString(requested) || requested.trim() === "") return walks;
  const name = requested.trim();
  const match = walks.filter((walk) => walk?.name === name);
  if (match.length !== 1) {
    const valid = walks
      .map((walk) => (isString(walk?.name) ? walk.name : ""))
      .filter((item) => item.length > 0)
      .join(", ");
    throw new Error(`unknown profile ${JSON.stringify(name)}; valid: ${valid}`);
  }
  return match;
}
