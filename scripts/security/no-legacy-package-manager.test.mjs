import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const legacy = "pn" + "pm";
const core = "core" + "pack";
const workspaceFile = `${legacy}-workspace.yaml`;

const patterns = [
  { name: legacy, re: new RegExp(`\\b${legacy}\\b`, "u") },
  { name: core, re: new RegExp(`\\b${core}\\b`, "iu") },
  { name: "node" + ":22", re: new RegExp("node" + ":22", "u") },
  { name: "node" + " 22", re: new RegExp("node" + " 22", "u") },
  { name: "Node" + " 22", re: new RegExp("Node" + " 22", "u") },
  {
    name: `${legacy}/action-setup`,
    re: new RegExp(`${legacy}/action-setup`, "u"),
  },
];

function excluded(path) {
  if (path === "package-lock.json" || path.endsWith("/package-lock.json")) {
    return true;
  }
  if (path.startsWith("staging/tyler-dotfiles/")) return true;
  // Later stack PRs own CI workflows and the Cursor image.
  if (path.startsWith(".github/workflows/")) return true;
  if (path === ".cursor/Dockerfile") return true;
  return false;
}

function scrub(text) {
  return text.replaceAll(workspaceFile, "");
}

test("tracked product files do not use the legacy package manager or Node 22", () => {
  const listed = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" });
  const hits = [];
  for (const path of listed.split("\0")) {
    if (!path || excluded(path)) continue;
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\0")) continue;
    const source = scrub(text);
    for (const pattern of patterns) {
      if (pattern.re.test(source)) {
        hits.push(`${path}: ${pattern.name}`);
      }
    }
    const setup = /actions\/setup-node|setup-node@/u.test(source);
    const node22 = /node-version:\s*['"]?22\b/u.test(source);
    if (setup && node22) hits.push(`${path}: setup-node node-version 22`);
  }
  assert.deepEqual(hits, []);
});
