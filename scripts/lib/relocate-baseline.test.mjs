import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readRelocationMap, relocateBaseline } from "./relocate-baseline.mjs";

const gone = () => false;

describe("relocateBaseline", () => {
  it("carries a recorded entry to its new path unchanged", () => {
    const { files, moved, refusals } = relocateBaseline(
      { "a/store.ts": { "max-lines": 1726, complexity: 2 } },
      { "a/store.ts": "b/store.ts" },
      gone,
    );
    expect(refusals).toEqual([]);
    expect(moved).toBe(1);
    expect(files).toEqual({
      "b/store.ts": { "max-lines": 1726, complexity: 2 },
    });
  });

  it("leaves unrelated entries alone", () => {
    const { files } = relocateBaseline(
      { "a/x.ts": { "max-lines": 500 }, "c/y.ts": { complexity: 1 } },
      { "a/x.ts": "b/x.ts" },
      gone,
    );
    expect(files["c/y.ts"]).toEqual({ complexity: 1 });
  });

  it("moves a debt-free file without inventing an entry", () => {
    const { files, moved, refusals } = relocateBaseline(
      {},
      { "a/clean.ts": "b/clean.ts" },
      gone,
    );
    expect(refusals).toEqual([]);
    expect(moved).toBe(0);
    expect(files).toEqual({});
  });

  it("refuses when the old path still exists", () => {
    const { refusals } = relocateBaseline(
      { "a/x.ts": { "max-lines": 500 } },
      { "a/x.ts": "b/x.ts" },
      (path) => path === "a/x.ts",
    );
    expect(refusals).toEqual(["a/x.ts: still exists, so this is not a move"]);
  });

  it("refuses to overwrite an entry already at the destination", () => {
    const { refusals } = relocateBaseline(
      { "a/x.ts": { "max-lines": 500 }, "b/x.ts": { "max-lines": 450 } },
      { "a/x.ts": "b/x.ts" },
      gone,
    );
    expect(refusals).toEqual(["b/x.ts: already has a baseline entry"]);
  });

  it("refuses a path mapped to itself", () => {
    const { refusals } = relocateBaseline({}, { "a/x.ts": "a/x.ts" }, gone);
    expect(refusals).toEqual(["a/x.ts: maps to itself"]);
  });
});

describe("readRelocationMap", () => {
  it("reads a moves object", () => {
    expect(readRelocationMap({ moves: { "a/x.ts": "b/x.ts" } })).toEqual({
      "a/x.ts": "b/x.ts",
    });
  });

  it.each([
    [null],
    [{}],
    [{ moves: [] }],
    [{ moves: { "a/x.ts": 3 } }],
    [{ moves: { "/abs/x.ts": "b/x.ts" } }],
    [{ moves: { "a/x.ts": "b\\x.ts" } }],
    [{ moves: { "a\\x.ts": "b/x.ts" } }],
  ])("refuses a malformed map %j", (parsed) => {
    expect(() => readRelocationMap(parsed)).toThrow();
  });
});

it("applies the suite-size exemption to JS tests without weakening other budgets", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const fixture = mkdtempSync(join(tmpdir(), "quality-test-files-"));
  try {
    const statements = Array.from(
      { length: 105 },
      (_, i) => `const v${i} = ${i};`,
    ).join("\n");
    const suite = `describe("fixture", () => {\n${statements}\n});\n`;
    const extensions = [
      "test.js",
      "test.mjs",
      "test.cjs",
      "spec.js",
      "spec.mjs",
      "spec.cjs",
    ];
    for (const extension of extensions)
      writeFileSync(join(fixture, `suite.${extension}`), suite);
    writeFileSync(join(fixture, "source.mjs"), suite);
    writeFileSync(
      join(fixture, "oversized.test.mjs"),
      suite + "// filler\n".repeat(300),
    );
    const branches = Array.from({ length: 16 }, (_, i) => `x === ${i}`).join(
      " || ",
    );
    writeFileSync(
      join(fixture, "complex.test.mjs"),
      `function complex(x) { return ${branches}; }\n`,
    );
    const result = spawnSync(
      join(root, "node_modules/.bin/oxlint"),
      [
        "--config",
        join(root, "tools/quality/oxlint.complexity.jsonc"),
        "--format=json",
        "--threads=1",
        fixture,
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.error).toBeUndefined();
    const diagnostics = JSON.parse(result.stdout).diagnostics;
    const codes = (file) =>
      diagnostics
        .filter((entry) => basename(entry.filename) === file)
        .map((entry) => entry.code);
    for (const extension of extensions)
      expect(codes(`suite.${extension}`)).toEqual([]);
    expect(codes("source.mjs")).toEqual(
      expect.arrayContaining([
        "eslint(max-statements)",
        "eslint(max-lines-per-function)",
      ]),
    );
    expect(codes("oversized.test.mjs")).toContain("eslint(max-lines)");
    expect(codes("complex.test.mjs")).toContain("eslint(complexity)");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
