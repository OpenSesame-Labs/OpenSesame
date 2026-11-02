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

// These tests may name a forbidden tool only to assert that it is absent.
// A failing stand-in is a join() path or the script beside it that exits 99.
const guardTests = new Set([
  "scripts/security/ci-mise-action.test.mjs",
  "scripts/security/cloud-tooling.test.mjs",
  "scripts/security/dotfiles-bootstrap.test.mjs",
  "scripts/security/no-legacy-package-manager.test.mjs",
]);

function assertsAbsence(line) {
  if (/\bdoesNotMatch\b/u.test(line)) return true;
  if (/\.includes\(/u.test(line) && /\bfalse\b/u.test(line)) return true;
  if (/\btest\s*\(/u.test(line) && /\bnot\b/iu.test(line)) return true;
  return false;
}

function standIn(lines, index) {
  const line = lines[index];
  const nearby = `${lines[index - 1] ?? ""}\n${lines[index + 1] ?? ""}`;
  if (/exit\s+99/u.test(line)) return /\bjoin\s*\(/u.test(nearby);
  if (!/exit\s+99/u.test(nearby)) return false;
  return /\bjoin\s*\(/u.test(line);
}

function stripAbsenceAssertions(text) {
  const lines = text.split("\n");
  return lines
    .map((line, index) =>
      assertsAbsence(line) || standIn(lines, index) ? "" : line,
    )
    .join("\n");
}

function scrub(path, text) {
  const source = text.replaceAll(workspaceFile, "");
  if (!guardTests.has(path)) return source;
  return stripAbsenceAssertions(source);
}

function scanText(path, text) {
  const source = scrub(path, text);
  const hits = [];
  for (const pattern of patterns) {
    if (pattern.re.test(source)) hits.push(`${path}: ${pattern.name}`);
  }
  const setup = /actions\/setup-node|setup-node@/u.test(source);
  const node22 = /node-version:\s*['"]?22\b/u.test(source);
  if (setup && node22) hits.push(`${path}: setup-node node-version 22`);
  return hits;
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
    hits.push(...scanText(path, text));
  }
  assert.deepEqual(hits, []);
});

test("guard allowlist still reports a real invocation", () => {
  const guard = "scripts/security/cloud-tooling.test.mjs";
  const tool = "core" + "pack";
  const assertion = `assert.doesNotMatch(text, /${legacy}/);`;
  const invocation = `run("${legacy}", ["install"]);`;
  const title = 'test("files do not mention ' + "Node" + ' 22", () => {';
  const absentInclude = `assert.equal(text.includes("${legacy}"), false);`;
  const stub = [
    "writeFileSync(",
    `  join(bin, "${tool}"),`,
    `  "#!/bin/sh\\nprintf '%s\\\\n' '${tool} invoked' >&2\\nexit 99\\n",`,
    ");",
  ].join("\n");
  const prose = `the image runs ${tool} install`;

  assert.deepEqual(scanText(guard, assertion), []);
  assert.deepEqual(scanText(guard, title), []);
  assert.deepEqual(scanText(guard, absentInclude), []);
  assert.deepEqual(scanText(guard, stub), []);
  assert.deepEqual(scanText(guard, invocation), [`${guard}: ${legacy}`]);
  assert.deepEqual(scanText(guard, prose), [`${guard}: ${tool}`]);
  assert.deepEqual(scanText("docs/example.md", assertion), [
    `docs/example.md: ${legacy}`,
  ]);
});
