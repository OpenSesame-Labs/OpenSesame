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

/** The indented body of a mapping key, excluding sibling keys. */
function section(lines, name, parentIndent) {
  const header = new RegExp(`^(\\s*)${name}:\\s*$`);
  let start = -1;
  let indent = parentIndent;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const current = /^(\s*)\S/.exec(line)?.[1].length ?? 0;
    if (start >= 0 && current <= indent)
      return { lines: lines.slice(start, i), indent };
    const match = header.exec(line);
    if (start < 0 && match && current > parentIndent) {
      start = i + 1;
      indent = current;
    }
  }
  return { lines: start < 0 ? [] : lines.slice(start), indent };
}

/** @param {string} yaml */
export function workflowPathFilters(yaml) {
  const on = section(yaml.split("\n"), "on", -1);
  const push = section(on.lines, "push", on.indent);
  const paths = section(push.lines, "paths", push.indent);
  return paths.lines.flatMap((line) => {
    const match = /^(\s*)-\s*"(.+)"\s*$/.exec(line);
    return match && match[1].length > paths.indent ? [match[2]] : [];
  });
}

/** @param {string} dir */
export function packageGlob(dir) {
  return `${dir.replace(/\/$/, "")}/**`;
}

/**
 * Exact package glob, or a broader parent glob (`packages/**` covers
 * `packages/foo/**`). A narrower child glob does not.
 *
 * @param {string} pattern
 * @param {string} glob
 */
function patternCovers(pattern, glob) {
  if (pattern === glob) return true;
  return pattern.endsWith("/**") && glob.startsWith(`${pattern.slice(0, -3)}/`);
}

/**
 * Last matching filter wins. A positive filter covers only when it is the
 * package glob or a broader parent. A `!` filter clears coverage when it is
 * the package glob, a broader parent, or a narrower child within the package
 * (a partial exclusion must not count as whole-package coverage). A later
 * positive filter can restore coverage.
 *
 * @param {string[]} filters
 * @param {string} glob package dir glob such as `packages/foo/**`
 */
export function pathCovers(filters, glob) {
  let covered = false;
  for (const filter of filters) {
    if (filter.startsWith("!")) {
      const neg = filter.slice(1);
      if (patternCovers(neg, glob) || patternCovers(glob, neg)) {
        covered = false;
      }
      continue;
    }
    if (patternCovers(filter, glob)) covered = true;
  }
  return covered;
}

/**
 * @param {string} repoRoot
 * @returns {{ ok: true } | { ok: false, missing: { name: string, glob: string }[] }}
 */
export function assertCdPwaPaths(
  repoRoot = root,
  components = typescriptComponents(repoRoot),
) {
  const byName = new Map(components.map((c) => [c.name, c]));
  if (!byName.has(PAGES)) {
    return {
      ok: false,
      missing: [{ name: PAGES, glob: PAGES_APP_GLOB }],
    };
  }
  const closure = productionClosure(components);
  const workflow = readFileSync(
    join(repoRoot, ".github/workflows/cd-pwa.yml"),
    "utf8",
  );
  const filters = workflowPathFilters(workflow);
  const missing = [];
  if (
    !filters.includes(PAGES_APP_GLOB) ||
    !pathCovers(filters, PAGES_APP_GLOB)
  ) {
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

function main() {
  const result = assertCdPwaPaths(root);
  if (!result.ok) {
    console.error("cd-pwa workspace path drift:");
    for (const { name, glob } of result.missing) {
      console.error(
        `  missing filter for ${name}: add "${glob}" to cd-pwa.yml paths`,
      );
    }
    process.exit(1);
  }
  console.log(
    `cd-pwa workspace paths: OK (${productionClosure(typescriptComponents(root)).length} production packages in Pages closure)`,
  );
}

const executed =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (executed) main();
