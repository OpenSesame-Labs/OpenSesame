#!/usr/bin/env node
/**
 * Ensures cd-pwa.yml push paths cover every production workspace package
 * reachable from @opensesame/pages (dependency-closure drift detector).
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { typescriptComponents } from "../lib/workspace-graph.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PAGES = "@opensesame/pages";
const PAGES_APP_GLOB = "apps/pages/**";

/** @param {import("../lib/workspace-graph.mjs").Component[]} components */
export function productionClosure(components) {
  const byName = new Map(components.map((c) => [c.name, c]));
  const seen = new Set();
  const queue = [PAGES];
  while (queue.length > 0) {
    const name = queue.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    const component = byName.get(name);
    if (!component) continue;
    for (const dep of component.deps) queue.push(dep);
  }
  return [...seen]
    .map((name) => byName.get(name))
    .filter((component) => component !== undefined);
}

/** @param {string} yaml */
export function workflowPathFilters(yaml) {
  const lines = yaml.split("\n");
  const paths = [];
  let inPaths = false;
  let pathsIndent = 0;
  for (const line of lines) {
    if (!inPaths) {
      const header = /^(\s*)paths:\s*$/.exec(line);
      if (header) {
        inPaths = true;
        pathsIndent = header[1].length;
      }
      continue;
    }
    const match = /^(\s*)-\s*"(.+)"\s*$/.exec(line);
    if (match && match[1].length > pathsIndent) {
      paths.push(match[2]);
      continue;
    }
    if (line.trim() && !/^\s*#/.test(line)) inPaths = false;
  }
  return paths;
}

/** @param {string} dir */
export function packageGlob(dir) {
  return `${dir.replace(/\/$/, "")}/**`;
}

/**
 * @param {string[]} filters
 * @param {string} glob package dir glob such as `packages/foo/**`
 */
export function pathCovers(filters, glob) {
  const pkgRoot = glob.slice(0, -3);
  return filters.some((filter) => {
    if (filter === glob) return true;
    if (filter.endsWith("/**") && glob.startsWith(`${filter.slice(0, -3)}/`)) {
      return true;
    }
    if (glob.endsWith("/**") && filter.startsWith(`${pkgRoot}/`)) return true;
    return false;
  });
}

/**
 * @param {string} repoRoot
 * @returns {{ ok: true } | { ok: false, missing: { name: string, glob: string }[] }}
 */
export function assertCdPwaPaths(repoRoot = root) {
  const components = typescriptComponents(repoRoot);
  const closure = productionClosure(components);
  const workflow = readFileSync(
    join(repoRoot, ".github/workflows/cd-pwa.yml"),
    "utf8",
  );
  const filters = workflowPathFilters(workflow);
  const missing = [];
  if (!filters.includes(PAGES_APP_GLOB)) {
    missing.push({ name: PAGES, glob: PAGES_APP_GLOB });
  }
  for (const component of closure) {
    if (component.name === PAGES) continue;
    const glob = packageGlob(component.dir);
    if (!pathCovers(filters, glob)) {
      missing.push({ name: component.name, glob });
    }
  }
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true };
}

const result = assertCdPwaPaths(root);
if (!result.ok) {
  console.error("cd-pwa workspace path drift:");
  for (const { name, glob } of result.missing) {
    console.error(`  missing filter for ${name}: add "${glob}" to cd-pwa.yml paths`);
  }
  process.exit(1);
}
console.log(
  `cd-pwa workspace paths: OK (${productionClosure(typescriptComponents(root)).length} production packages in Pages closure)`,
);