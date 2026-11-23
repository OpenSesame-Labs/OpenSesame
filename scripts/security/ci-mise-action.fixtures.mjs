/**
 * Shared readers for the `ci-mise-action*.test.mjs` files: the workflow
 * directory, the YAML parser, the pinned mise-action reference, and the
 * text of a step's `run`.
 */
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readString } from "../lib/json-boundary.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const workflowDir = join(root, ".github/workflows");
export const { parse } = createRequire(import.meta.url)("yaml");

// Reviewed 2026-11-23: v5.2.8 (Dependabot #2835); tag SHA checked against
// refs/tags/v5.2.8 on github.com/jdx/mise-action.
export const miseUses =
  "jdx/mise-action@d5574b52816a478f9d4e6529a3f6ff17a8a36785";

export function workflows() {
  return readdirSync(workflowDir)
    .filter((name) => name.endsWith(".yml"))
    .sort()
    .map((name) => ({
      name,
      text: readFileSync(join(workflowDir, name), "utf8"),
    }));
}

export function runText(step) {
  return readString(step?.run) ?? "";
}
