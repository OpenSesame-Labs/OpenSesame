import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * The directory of the copy of `name` that a workspace member resolves, found
 * through Node's own resolution from the member's package.json. A config that
 * names `<member>/node_modules/<name>` holds only under npm's isolated
 * layout; this holds under any node_modules layout: the member's own copy, a
 * hoisted copy at the root, or a copy nested under the member because the
 * root's does not satisfy it. `specifier` is what is resolved, for a package
 * whose exports name subpaths only (`@opensesame/app-core/host.js`).
 */
export function dependencyRoot(memberPackageJson, name, specifier = name) {
  const entry = createRequire(memberPackageJson).resolve(specifier);
  for (let dir = dirname(entry); dirname(dir) !== dir; dir = dirname(dir)) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest) && manifestName(manifest) === name) return dir;
  }
  throw new Error(`${name} resolves to ${entry}, outside any package root`);
}

function manifestName(path) {
  const { name } = JSON.parse(readFileSync(path, "utf8"));
  return name;
}

const identifierStart = /[A-Za-z_$]/;
const identifierChar = /[A-Za-z0-9_$]/;
const stringQuotes = new Set(['"', "'", "`"]);

function isCommentStart(source, index) {
  return (
    source[index] === "/" &&
    (source[index + 1] === "/" || source[index + 1] === "*")
  );
}

function skipString(source, index) {
  const quote = source[index];
  index += 1;
  while (index < source.length) {
    if (source[index] === "\\") index += 1;
    else if (source[index] === quote) return index + 1;
    index += 1;
  }
  return index;
}

function skipComment(source, index) {
  if (source[index + 1] === "/") {
    while (index < source.length && source[index] !== "\n") index += 1;
    return index;
  }
  index += 2;
  while (
    index < source.length &&
    !(source[index] === "*" && source[index + 1] === "/")
  ) {
    index += 1;
  }
  return index + 2;
}

/** Static module specifiers, excluding comments, strings, and dynamic imports. */
export function extractModuleSpecifiers(source) {
  const specifiers = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (isCommentStart(source, index)) {
      index = skipComment(source, index);
      continue;
    }
    if (stringQuotes.has(char)) {
      index = skipString(source, index);
      continue;
    }
    if (!identifierStart.test(char)) {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < source.length && identifierChar.test(source[end])) end += 1;
    const word = source.slice(index, end);
    index = end;
    if (word !== "import" && word !== "export") continue;
    index = consumeStatementSpecifiers(source, index, word, specifiers);
  }
  return specifiers;
}

function consumeStatementSpecifiers(source, index, keyword, specifiers) {
  let previousWord = keyword;
  while (index < source.length) {
    const char = source[index];
    if (char === ";") break;
    if (isCommentStart(source, index)) {
      index = skipComment(source, index);
      continue;
    }
    if (char === '"' || char === "'") {
      const start = index;
      index = skipString(source, index);
      if (previousWord === "import" || previousWord === "from") {
        specifiers.push(source.slice(start + 1, index - 1));
      }
      previousWord = "";
      continue;
    }
    if (char === "`") {
      index = skipString(source, index);
      previousWord = "";
      continue;
    }
    if (identifierStart.test(char)) {
      let end = index + 1;
      while (end < source.length && identifierChar.test(source[end])) end += 1;
      previousWord = source.slice(index, end);
      index = end;
      continue;
    }
    if (char === "(" && previousWord === "import") break;
    index += 1;
  }
  return index;
}
