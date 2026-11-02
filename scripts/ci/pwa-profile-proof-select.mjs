/**
 * Choose which install-profile walks a proof process builds.
 * An empty request keeps every walk. One name keeps that walk.
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
