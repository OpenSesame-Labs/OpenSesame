import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "vitest";
import {
  chunkImports,
  importRecord,
  loadLexer,
} from "./verify-dist-checks.mjs";

const repoRoot = resolve(import.meta.dirname, "../../../..");

test("reads static, dynamic and import.meta edges from the installed lexer", async () => {
  const { init, parse } = await loadLexer(repoRoot);
  await init;
  const code = [
    'import a from "./static.js";',
    'export * from "./reexport.js";',
    'import("./dynamic.js");',
    "import(`./template.js`);",
    "import(dynamicName);",
    'import "https://cdn.example/x.js";',
    "console.log(import.meta.url, a);",
  ].join("\n");
  const edges = chunkImports(parse, code, "assets/main.js");
  assert.deepEqual([...edges.static].sort(), [
    "assets/reexport.js",
    "assets/static.js",
  ]);
  assert.deepEqual([...edges.dynamic].sort(), [
    "assets/dynamic.js",
    "assets/template.js",
  ]);
  assert.deepEqual([...edges.external], ["https://cdn.example/x.js"]);
});

test("normalizes both lexer record shapes and refuses unknown ones", () => {
  assert.deepEqual(importRecord({ d: -1, n: "./a.js", s: 1, e: 2 }), {
    kind: "static",
    specifier: "./a.js",
    start: 1,
    end: 2,
  });
  assert.equal(importRecord({ d: -2, s: 0, e: 0 }).kind, "meta");
  assert.equal(importRecord({ d: 4, s: 0, e: 0 }).kind, "dynamic");
  assert.deepEqual(
    importRecord({ type: "dynamic", specifier: undefined, start: 3, end: 9 }),
    { kind: "dynamic", specifier: undefined, start: 3, end: 9 },
  );
  assert.equal(
    importRecord({ type: "import-meta", specifier: null, start: 0, end: 1 })
      .specifier,
    undefined,
  );
  assert.throws(() => importRecord({ type: "future", start: 0, end: 0 }));
  assert.throws(() => importRecord({}));
});
