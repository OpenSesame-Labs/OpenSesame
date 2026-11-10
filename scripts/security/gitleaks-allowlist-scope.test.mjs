import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
// Both scanners' configs are held to the same rule: gitleaks 8.x reads
// `.gitleaks.toml`, Betterleaks reads `.betterleaks.toml` (which extends it).
const configs = [".gitleaks.toml", ".betterleaks.toml"].map((name) => ({
  name,
  text: readFileSync(`${root}${name}`, "utf8"),
}));
const ignore = readFileSync(`${root}.gitleaksignore`, "utf8");

// Read TOML path arrays without mistaking a `]` in a quoted regex for the
// end of the array. Reject unknown syntax so an edit cannot silently skip it.
function pathPatterns(block) {
  const match = /^\s*paths\s*=\s*\[/m.exec(block);
  if (!match) return [];
  let cursor = match.index + match[0].length;
  const entries = [];
  while (cursor < block.length) {
    while (/\s|,/.test(block[cursor] ?? "")) cursor++;
    if (block[cursor] === "#") {
      const next = block.indexOf("\n", cursor);
      cursor = next < 0 ? block.length : next + 1;
      continue;
    }
    if (block[cursor] === "]") return entries;
    const delimiter = block.startsWith("'''", cursor) ? "'''" : "'";
    assert.equal(
      block.slice(cursor, cursor + delimiter.length),
      delimiter,
      "Use literal TOML strings in global path allowlists",
    );
    const start = cursor + delimiter.length;
    const end = block.indexOf(delimiter, start);
    assert.notEqual(end, -1, "Unterminated path allowlist entry");
    entries.push(block.slice(start, end));
    cursor = end + delimiter.length;
  }
  throw new Error("Unterminated path allowlist");
}

function regexFor(pattern) {
  const insensitive = pattern.startsWith("(?i)");
  const source = (insensitive ? pattern.slice(4) : pattern)
    .replaceAll("\\A", "^")
    .replaceAll("\\z", "$");
  return new RegExp(source, insensitive ? "i" : "");
}

/** Neither the path nor any directory above it may match the pattern. */
function assertPathNotExcluded(regex, path, pattern, name) {
  const parts = path.split("/");
  for (let size = 1; size <= parts.length; size++) {
    const candidate = parts.slice(0, size).join("/");
    assert.equal(
      regex.test(candidate),
      false,
      `${candidate} must not be excluded by ${pattern} in ${name}`,
    );
  }
}

test("global path exclusions do not hide secrets in production or vendor source", () => {
  const paths = ["scripts/test/live-turn/third_party/unreviewed/new_module.go"];
  for (const { name, text } of configs) {
    const blocks = text.split(/^\[\[allowlists\]\]\s*$/m).slice(1);
    assert.ok(blocks.length > 0, `Expected global allowlists in ${name}`);
    for (const block of blocks) {
      for (const pattern of pathPatterns(block)) {
        const regex = regexFor(pattern);
        for (const path of paths) {
          assertPathNotExcluded(regex, path, pattern, name);
        }
      }
    }
  }
});

test("an allowlist that pairs paths with regexes names its rules and ANDs them", () => {
  // gitleaks 8.30.1 ignores `regexes` next to `paths` in a GLOBAL allowlist (no
  // targetRules) and skips the whole file, whatever the condition. So narrowing
  // a path by value is only real when the entry names its rules and uses AND.
  // Not covered, by design: a value-only entry (anchored exact-secret regex, no
  // paths) is narrow by construction, and a path-only entry never claimed to
  // narrow by value.
  for (const { name, text } of configs) {
    const blocks = text.split(/^\[\[allowlists\]\]\s*$/m).slice(1);
    for (const block of blocks) {
      const body = block.split(/^\[(?!\[allowlists\]\])/m)[0];
      const hasRegexes = /^\s*regexes\s*=\s*\[/m.test(body);
      const hasPaths = /^\s*paths\s*=\s*\[/m.test(body);
      if (!(hasRegexes && hasPaths)) continue;
      const label =
        /^\s*description\s*=\s*"([^"]*)"/m.exec(body)?.[1] ??
        "(no description)";
      assert.match(
        body,
        /^\s*targetRules\s*=\s*\[\s*"[^"]+"/m,
        `${name}: "${label}" pairs paths with regexes but names no targetRules, so it would suppress the whole file`,
      );
      assert.match(
        body,
        /^\s*condition\s*=\s*"AND"/m,
        `${name}: "${label}" pairs paths with regexes without condition = "AND"`,
      );
    }
  }
});

test("historical exceptions are bound to an immutable commit and finding", () => {
  const lines = ignore
    .split("\n")
    .filter((line) => line && !line.startsWith("#"));
  assert.ok(lines.length > 0, "Expected reviewed historical fingerprints");
  assert.equal(new Set(lines).size, lines.length, "Duplicate fingerprints");
  for (const line of lines)
    assert.match(line, /^[a-f0-9]{40}:[^:\n]+:[a-z0-9.-]+:[1-9][0-9]*$/);
  assert.ok(
    !lines.some((line) =>
      line.startsWith(
        "c9862a0e99b1fc7a8bc3169ec8158dd9abaebf01:apps/pages/src/lib/transport-settings.test.ts:github-pat:42",
      ),
    ),
    "An unverified credential-shaped finding must stay visible",
  );
});
