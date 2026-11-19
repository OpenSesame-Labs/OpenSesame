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

function productionClosure(components) {
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

function workflowPathFilters(yaml) {
  const lines = yaml.split("\n");
  const paths = [];
  let inPaths = false;
  for (const line of lines) {
    if (/^\s*paths:\s*$/.test(line)) {
      inPaths = true;
      continue;
    }
    if (inPaths) {
      const match = /^\s*-\s*"(.+)"\s*$/.exec(line);
      if (match) {
        paths.push(match[1]);
        continue;
      }
      if (/^\S/.test(line) || /^\s{0,1}\w/.test(line)) {
        inPaths = false;
      }
    }
  }
  return paths;
}

function packageGlob(dir) {
  return `${dir.replace(/\/$/, "")}/**`;
}

function pathCovers(filters, glob) {
  return filters.some(
    (filter) => filter === glob || filter.startsWith(`${glob.slice(0, -3)}/`),
  );
}

const components = typescriptComponents(root);
const closure = productionClosure(components);
const workflow = readFileSync(
  join(root, ".github/workflows/cd-pwa.yml"),
  "utf8",
);
const filters = workflowPathFilters(workflow);
const missing = [];
for (const component of closure) {
  if (component.name === PAGES) continue;
  const glob = packageGlob(component.dir);
  if (!pathCovers(filters, glob)) {
    missing.push({ name: component.name, glob });
  }
}

if (missing.length > 0) {
  console.error("cd-pwa workspace path drift:");
  for (const { name, glob } of missing) {
    console.error(`  missing filter for ${name}: add "${glob}" to cd-pwa.yml paths`);
  }
  process.exit(1);
}
console.log(
  `cd-pwa workspace paths: OK (${closure.length} production packages in Pages closure)`,
);