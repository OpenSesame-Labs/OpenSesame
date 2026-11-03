/**
 * Proof workflows check out a shallow blobless sparse tree.
 * Full history is fetch-depth 0 plus a `# checkout-history:` comment.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRootFromHere } from "./ci-changed-areas.mjs";
import {
  PROOF_CHECKOUT_PLAN,
  PROOF_WORKFLOW_PATHS,
  TRUNK_INVENTORY_COMMAND,
} from "./ci-sparse-checkout-paths.mjs";

const CHECKOUT_USES = /^\s*- uses: actions\/checkout@[^\s#]+(?: #.*)?$/;

/** @returns {{ line: number, block: string, historyReason: string | null }[]} */
function checkoutBlocks(content) {
  const lines = content.split("\n");
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!CHECKOUT_USES.test(lines[index])) continue;
    let historyReason = null;
    for (let back = index - 1; back >= 0 && back >= index - 6; back -= 1) {
      const reason = /#\s*checkout-history:\s*(.+)/.exec(lines[back]);
      if (reason) {
        historyReason = reason[1].trim();
        break;
      }
      if (
        lines[back].trim().length > 0 &&
        !lines[back].trim().startsWith("#")
      ) {
        break;
      }
    }
    const blockLines = [lines[index]];
    const baseIndent = lines[index].match(/^(\s*)/)?.[1].length ?? 0;
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next];
      if (line.trim().length === 0) {
        blockLines.push(line);
        continue;
      }
      const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
      if (indent <= baseIndent && line.trim().startsWith("- ")) break;
      if (indent <= baseIndent && /^ {2}[a-z][a-z0-9_-]*:/.test(line)) break;
      blockLines.push(line);
    }
    blocks.push({
      line: index + 1,
      block: blockLines.join("\n"),
      historyReason,
    });
    index += blockLines.length - 1;
  }
  return blocks;
}

function sparsePaths(block) {
  const lines = block.split("\n");
  const start = lines.findIndex((line) => /sparse-checkout:\s*\|/.test(line));
  if (start < 0) return [];
  const paths = [];
  for (const line of lines.slice(start + 1)) {
    const entry = /^(\s+)(\S.*)$/.exec(line);
    if (!entry) break;
    paths.push(entry[2].trim());
  }
  return paths;
}

describe("sparse shallow checkout (proof workflows)", () => {
  const root = repoRootFromHere();

  it("checks out each proof step shallow and blobless, or full history with a comment", () => {
    const violations = [];
    for (const rel of PROOF_WORKFLOW_PATHS) {
      const content = readFileSync(join(root, rel), "utf8");
      const plan = PROOF_CHECKOUT_PLAN[rel];
      const blocks = checkoutBlocks(content);
      if (blocks.length !== plan.length) {
        violations.push(
          `${rel} has ${blocks.length} checkouts, plan has ${plan.length}`,
        );
        continue;
      }
      for (let index = 0; index < blocks.length; index += 1) {
        const entry = blocks[index];
        const spec = plan[index];
        const where = `${rel}:${entry.line}`;
        const depth = /fetch-depth:\s*(\d+)/.exec(entry.block);
        const fetchDepth = depth ? Number(depth[1]) : null;
        if (!/filter:\s*blob:none/.test(entry.block)) {
          violations.push(`${where} missing filter: blob:none`);
        }
        if (!/sparse-checkout-cone-mode:\s*false/.test(entry.block)) {
          violations.push(`${where} missing sparse-checkout-cone-mode: false`);
        }
        const paths = sparsePaths(entry.block);
        if (paths.join("\n") !== spec.paths.join("\n")) {
          violations.push(`${where} sparse paths differ from the shared list`);
        }
        if (spec.history) {
          if (fetchDepth !== 0) {
            violations.push(`${where} history checkout must use fetch-depth 0`);
          }
          if (entry.historyReason !== spec.history) {
            violations.push(
              `${where} missing # checkout-history: ${spec.history}`,
            );
          }
        } else {
          if (fetchDepth !== 1) {
            violations.push(`${where} default checkout must use fetch-depth 1`);
          }
          if (entry.historyReason) {
            violations.push(
              `${where} checkout-history is only for fetch-depth 0`,
            );
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("runs this contract from the workflow inventory gate", () => {
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    const job = ci
      .split("\n  workflow-inventory-gate:\n")[1]
      .split("\n  changes:\n")[0];
    expect(job).toContain(TRUNK_INVENTORY_COMMAND);
    const typescriptBuild = ci
      .split("\n  typescript-build:\n")[1]
      .split("\n  rust-build:\n")[0];
    expect(typescriptBuild).not.toContain(TRUNK_INVENTORY_COMMAND);
  });
});
