/**
 * Candidate coverage must refuse an untrusted pull-request checkout.
 * Step blocks follow scripts/lib/ci-sparse-checkout.test.mjs. Named steps
 * put `uses:` on the line after `- name:`, so that line starts a block too.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRootFromHere } from "./ci-changed-areas.mjs";

const WORKFLOW = ".github/workflows/ci-coverage.yml";

const CHECKOUT_USES = /^\s*(?:- )?uses: actions\/checkout@[^\s#]+(?: #.*)?$/;
const CHECKOUT_USES_ANY = /uses:\s*actions\/checkout@/;

/** @returns {{ line: number, block: string }[]} */
function checkoutBlocks(content) {
  const lines = content.split("\n");
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!CHECKOUT_USES.test(lines[index])) continue;
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
    });
    index += blockLines.length - 1;
  }
  return blocks;
}

/** @param {string} block */
function refusesUnsafePrCheckout(block) {
  const lines = block.split("\n");
  const withAt = lines.findIndex((line) => /^\s*with:\s*$/.test(line));
  if (withAt < 0) return false;
  const withIndent = lines[withAt].match(/^(\s*)/)?.[1].length ?? 0;
  for (const line of lines.slice(withAt + 1)) {
    if (line.trim().length === 0) continue;
    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
    if (indent <= withIndent) break;
    if (/^allow-unsafe-pr-checkout:\s*false\s*$/.test(line.trim())) return true;
  }
  return false;
}

describe("ci-coverage untrusted checkout", () => {
  const content = readFileSync(join(repoRootFromHere(), WORKFLOW), "utf8");
  const blocks = checkoutBlocks(content);

  it("sets allow-unsafe-pr-checkout false on every actions/checkout step", () => {
    const usesLines = content
      .split("\n")
      .filter((line) => CHECKOUT_USES_ANY.test(line)).length;
    const violations = [];
    if (blocks.length !== usesLines) {
      violations.push(
        `${WORKFLOW} has ${blocks.length} checkout blocks and ${usesLines} actions/checkout uses lines`,
      );
    }
    let trustedHelpers = 0;
    let sourceShas = 0;
    for (const entry of blocks) {
      const where = `${WORKFLOW}:${entry.line}`;
      if (!refusesUnsafePrCheckout(entry.block)) {
        violations.push(`${where} missing allow-unsafe-pr-checkout: false`);
      }
      if (/sparse-checkout:/.test(entry.block)) trustedHelpers += 1;
      if (/inputs\.source_sha/.test(entry.block)) {
        sourceShas += 1;
      }
    }
    if (trustedHelpers < 1) {
      violations.push(`${WORKFLOW} missing a trusted-helper sparse checkout`);
    }
    if (sourceShas < 1) {
      violations.push(`${WORKFLOW} missing a candidate source_sha checkout`);
    }
    expect(violations).toEqual([]);
  });

  it("rejects a checkout block whose with map omits the refusal", () => {
    const sample = [
      "    - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0",
      "      with:",
      "        ref: ${{ inputs.source_sha }}",
      "        persist-credentials: false",
    ].join("\n");
    expect(refusesUnsafePrCheckout(sample)).toBe(false);
    expect(
      refusesUnsafePrCheckout(
        `${sample}\n        allow-unsafe-pr-checkout: false`,
      ),
    ).toBe(true);
  });
});
