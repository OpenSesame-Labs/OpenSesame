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

export const miseUses =
  "jdx/mise-action@f5be966e4a917d54244728e6a5fdcd1d93a35e6c";

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
