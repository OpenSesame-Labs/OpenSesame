import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as nodeTest from "node:test";
import { repoRootFromHere } from "./ci-changed-areas.mjs";

const { describe, it } =
  process.env.VITEST === "true" ? await import("vitest") : nodeTest;

const root = repoRootFromHere();
const workflowDir = join(root, ".github/workflows");

const ACTION_ORG = /^(?:actions|docker|github)\//;
const SHA_PIN = /@[0-9a-f]{40}$/;

function usesReference(line) {
  const hash = line.indexOf("#");
  const code = hash === -1 ? line : line.slice(0, hash);
  const match = /uses:\s*(['"]?)(\S+)/.exec(code);
  if (!match) return null;
  const quote = match[1];
  let ref = match[2];
  if (quote && ref.endsWith(quote)) ref = ref.slice(0, -1);
  return ref;
}

function unpinnedActionUses() {
  const violations = [];
  const names = readdirSync(workflowDir)
    .filter((name) => name.endsWith(".yml"))
    .sort();
  for (const name of names) {
    const relative = `.github/workflows/${name}`;
    const lines = readFileSync(join(workflowDir, name), "utf8").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const ref = usesReference(lines[index]);
      if (!ref || ref.startsWith("./")) continue;
      if (!ACTION_ORG.test(ref)) continue;
      if (SHA_PIN.test(ref)) continue;
      violations.push(`${relative}:${index + 1}`);
    }
  }
  return violations;
}

describe("GitHub Actions SHA pins", () => {
  it("requires a 40-character SHA on actions, docker, and github uses", () => {
    const violations = unpinnedActionUses();
    if (violations.length > 0) {
      throw new Error(violations.join("\n"));
    }
    assert.equal(violations.length, 0);
  });
});
