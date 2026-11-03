#!/usr/bin/env node
/**
 * Apply the shared sparse shallow checkout plan to the proof workflows.
 * Re-running replaces each actions/checkout step in order.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROOF_CHECKOUT_PLAN,
  TRUNK_INVENTORY_COMMAND,
  historyComment,
} from "../lib/ci-sparse-checkout-paths.mjs";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "../..");

function checkoutLineIndexes(lines) {
  return lines.flatMap((line, index) =>
    line.includes("actions/checkout@") ? [index] : [],
  );
}

function stepEnd(lines, index) {
  const baseIndent = lines[index].match(/^(\s*)/)?.[1] ?? "";
  let end = index + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() === "") {
      end += 1;
      continue;
    }
    if (
      line.startsWith(`${baseIndent}  `) ||
      line.startsWith(`${baseIndent}#`)
    ) {
      end += 1;
      continue;
    }
    break;
  }
  return end;
}

function renderStep(baseIndent, usesLine, spec) {
  const block = [];
  if (spec.history) block.push(`${baseIndent}${historyComment(spec.history)}`);
  block.push(usesLine);
  block.push(`${baseIndent}  with:`);
  block.push(`${baseIndent}    persist-credentials: false`);
  block.push(`${baseIndent}    fetch-depth: ${spec.history ? 0 : 1}`);
  block.push(`${baseIndent}    filter: blob:none`);
  block.push(`${baseIndent}    sparse-checkout-cone-mode: false`);
  block.push(`${baseIndent}    sparse-checkout: |`);
  for (const pattern of spec.paths) {
    block.push(`${baseIndent}      ${pattern}`);
  }
  return block;
}

function patchWorkflow(rel, specs) {
  const path = join(root, rel);
  const lines = readFileSync(path, "utf8").split("\n");
  const indexes = checkoutLineIndexes(lines);
  if (indexes.length !== specs.length) {
    throw new Error(
      `${rel} has ${indexes.length} checkouts, plan has ${specs.length}`,
    );
  }
  for (let nth = indexes.length - 1; nth >= 0; nth -= 1) {
    const index = checkoutLineIndexes(lines)[nth];
    const usesLine = lines[index];
    if (!usesLine.includes("actions/checkout@")) {
      throw new Error(`${rel} line ${index + 1} is not a checkout`);
    }
    const baseIndent = usesLine.match(/^(\s*)/)?.[1] ?? "";
    let start = index;
    if (lines[start - 1]?.includes("# checkout-history:")) start -= 1;
    const end = stepEnd(lines, index);
    lines.splice(
      start,
      end - start,
      ...renderStep(baseIndent, usesLine, specs[nth]),
    );
  }
  let text = lines.join("\n");
  if (
    rel === ".github/workflows/ci.yml" &&
    !text.includes(TRUNK_INVENTORY_COMMAND)
  ) {
    const previous =
      "npx vitest run scripts/lib/ci-container-build-pr.test.mjs";
    if (!text.includes(previous)) {
      throw new Error("ci.yml is missing the inventory vitest command");
    }
    text = text.replace(previous, TRUNK_INVENTORY_COMMAND);
  }
  writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`);
  process.stdout.write(`patched ${rel}\n`);
}

for (const [rel, specs] of Object.entries(PROOF_CHECKOUT_PLAN)) {
  patchWorkflow(rel, specs);
}
