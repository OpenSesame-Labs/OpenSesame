#!/usr/bin/env node
/**
 * Fail when a tracked source, doc, or spec file commits a contiguous
 * Tailscale kind prefix. Prefixes are assembled by provider-secret-patterns
 * so this script's path and source do not carry the provider stem.
 *
 * The pull-request template is scanned with the rest of the tree. Lockfiles,
 * dependencies, and build output are not key material.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tailscaleKeyMaterialLines } from "./provider-secret-patterns.mjs";

const SKIP_SEGMENTS = new Set(["node_modules", "target", "dist", ".git"]);
const SKIP_BASENAMES = new Set(["package-lock.json", "Cargo.lock"]);
const PULL_REQUEST_TEMPLATE = ".github/pull_request_template.md";
const SOURCE_EXT =
  /\.(?:[cm]?[jt]sx?|mjs|cjs|rs|py|go|kts?|swift|java|sh|bash|md|mdx|txt|json|ya?ml|toml|html|css|sql|proto|wit|rhai)$/u;

function gitRoot(start) {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: start,
    encoding: "utf8",
  }).trim();
}

function listedFiles(root) {
  const args = [
    ["ls-files", "-z"],
    ["ls-files", "-z", "--others", "--exclude-standard"],
  ];
  const found = new Set();
  for (const gitArgs of args) {
    const out = execFileSync("git", gitArgs, {
      cwd: root,
      encoding: "utf8",
    });
    for (const path of out.split("\0")) {
      if (path) found.add(path);
    }
  }
  return [...found];
}

/** True when this repo-relative path is source, docs, spec, or the PR template. */
export function isScannablePath(relPath) {
  const path = relPath.replaceAll("\\", "/");
  if (!path) return false;
  const parts = path.split("/");
  if (parts.some((part) => SKIP_SEGMENTS.has(part))) return false;
  if (SKIP_BASENAMES.has(parts.at(-1) ?? "")) return false;
  if (path === PULL_REQUEST_TEMPLATE) return true;
  if (path.startsWith("docs/") || path.startsWith("spec/")) return true;
  return SOURCE_EXT.test(path);
}

/**
 * @param {{ root?: string, files?: readonly string[] }} [options]
 * `files` scans those repo-relative paths. Otherwise scan tracked files plus
 * untracked files git is not ignoring.
 * @returns {string[]} `path:line` violations, sorted.
 */
export function findTailscaleKeyMaterialViolations(options = {}) {
  const root = options.root ?? gitRoot(process.cwd());
  const files = options.files ?? listedFiles(root);
  const violations = [];
  for (const relPath of files) {
    if (!isScannablePath(relPath)) continue;
    const absolute = resolve(root, relPath);
    let text;
    try {
      if (!statSync(absolute).isFile()) continue;
      text = readFileSync(absolute, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\0")) continue;
    for (const line of tailscaleKeyMaterialLines(text)) {
      violations.push(`${relPath}:${line}`);
    }
  }
  violations.sort();
  return violations;
}

function main() {
  const json = process.argv.includes("--json");
  const violations = findTailscaleKeyMaterialViolations();
  if (json) {
    console.log(JSON.stringify(violations));
  }
  if (violations.length === 0) {
    if (!json) console.log("Tailscale key material gate: CLEAN");
    return;
  }
  if (!json) {
    console.error("Tailscale key material gate: FAIL");
    for (const violation of violations) console.error(violation);
  }
  process.exitCode = 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
