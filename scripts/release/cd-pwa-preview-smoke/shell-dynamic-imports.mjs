import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const DYNAMIC_IMPORT = /import\s*\(\s*["']([^"']+)["']\s*\)/giu;
const VITE_DEP_ASSET = /["'](assets\/[^"']+\.(?:m?js|css))["']/giu;
/** Emitted `import … from "./chunk.js"` in Vite bundles (incl. minified). */
const STATIC_MODULE_FROM =
  /(?:^|[;,])import(?:\s+type\s+)?[\s\w*{},$]*?from\s*["'](\.[^"']+\.m?js)["']/giu;
const STATIC_EXPORT_FROM = /export\s+[^"']*from\s*["'](\.[^"']+\.m?js)["']/giu;

function normalizeDistRelative(pathPart, ref) {
  const parts = [];
  for (const part of pathPart.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) {
        throw new Error(`shell asset escapes dist: ${ref}`);
      }
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  if (parts.length === 0) {
    throw new Error(`shell asset path is empty: ${ref}`);
  }
  return parts.join("/");
}

export function dynamicImportRefsFromJs(source) {
  const refs = new Set();
  for (const match of source.matchAll(DYNAMIC_IMPORT)) {
    refs.add(match[1]);
  }
  for (const match of source.matchAll(VITE_DEP_ASSET)) {
    refs.add(match[1]);
  }
  for (const match of source.matchAll(STATIC_MODULE_FROM)) {
    refs.add(match[1]);
  }
  for (const match of source.matchAll(STATIC_EXPORT_FROM)) {
    refs.add(match[1]);
  }
  return [...refs];
}

export function resolveDistImport(fromDistRelative, ref) {
  const combined = join(dirname(fromDistRelative), ref).split("\\").join("/");
  return normalizeDistRelative(combined, ref);
}

export function expandDynamicShellImports(
  distDir,
  pagesBase,
  seedAbsPaths,
  distRelativeOf,
  stagedFilePath,
  assetRelative,
) {
  const root = distDir;
  const base = pagesBase;
  const seen = new Set();
  const queue = [...seedAbsPaths];
  const paths = [];
  while (queue.length > 0) {
    const abs = queue.shift();
    const distRelative = distRelativeOf(root, abs);
    if (seen.has(distRelative)) continue;
    seen.add(distRelative);
    paths.push(abs);
    if (!/\.m?js$/iu.test(distRelative)) continue;
    let text;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    for (const ref of dynamicImportRefsFromJs(text)) {
      let distRel;
      if (ref.startsWith("/")) {
        distRel = assetRelative(ref, base);
      } else if (ref.startsWith(".") || ref.startsWith("assets/")) {
        distRel = ref.startsWith("assets/")
          ? ref
          : resolveDistImport(distRelative, ref);
      } else {
        continue;
      }
      if (distRel === undefined || seen.has(distRel)) continue;
      queue.push(stagedFilePath(root, distRel));
    }
  }
  return paths;
}
